import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { DispatchContextRow } from '../../../orchestration/db/orchestration-records'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { resolveRunBoundDispatchRecipient } from './messaging/recipient-routing'

/** One mailbox message per Dispatch; the existing delivery lane owns the pointer and retries. */
export function queueDispatchTask(args: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  dispatch: DispatchContextRow
  from: string
  preamble: string
}): void {
  const id = `msg_task_${args.dispatch.id}`
  const recipient = resolveRunBoundDispatchRecipient(args.runtime, args.db, args.dispatch.id)
  const mailbox = recipient?.to ?? `dispatch:${args.dispatch.id}`
  if (!args.db.getMessageById(id)) {
    args.db.insertMessage({
      id,
      from: args.from,
      to: mailbox,
      subject: 'Task',
      body: args.preamble,
      runId: recipient?.runId ?? args.dispatch.run_id
    })
  }
  args.runtime.notifyMessageArrived(args.db.getMessageById(id)?.to_handle ?? mailbox, 'status')
}
