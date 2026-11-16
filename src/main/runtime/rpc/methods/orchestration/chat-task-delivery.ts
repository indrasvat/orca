import { conversationRecordReader } from '../../../orchestration/addressing/session-lineage/structured-session-lineage'
import type { AgentMessageSource } from '../../../../../shared/agent-session/agent-session-message-source'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { observeChatAssignee } from '../../../orchestration/workers/lifecycle/chat-assignee'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import type { DispatchContextRow } from '../../../orchestration/db/orchestration-records'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { queueDispatchTask } from './dispatch-task-mail'

export type ChatTaskDelivery = 'queued'

/** Existing chats read delegated tasks through their mailbox, just like other agent mail. */
export async function sendChatTask(args: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  dispatch: DispatchContextRow
  from: AgentMessageSource
  preamble: string
}): Promise<ChatTaskDelivery> {
  const sessionId = args.dispatch.assignee_orca_session_id
  const host = getStructuredAgentSessionHost()
  const observed =
    sessionId && host
      ? observeChatAssignee(sessionId, args.db, conversationRecordReader(host.deps.store))
      : null
  if (!host || observed?.status !== 'live') {
    throw new OrchestrationError(
      'dispatch_preamble_undelivered',
      `The task was not delivered: ${observed && observed.status !== 'live' ? observed.reason : 'the chat cannot be reached here.'}`
    )
  }
  queueDispatchTask({
    ...args,
    from: args.from.senders[0]?.party.address ?? 'coordinator'
  })
  return 'queued'
}
