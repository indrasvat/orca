import { queuedRows, queuedCardTexts } from './structured-chat-coordinator-journal.test-fixture'
import { readTestHostJournal } from '../../../../native-chat/agent-session-journal/journal-observation.test-support'
import '../../../rpc/dispatch/testing/unused-default-rpc-methods.test-fixture'

import { describe, expect, it, vi } from 'vitest'
import { agentSessionSendSubmission } from '../../../../../shared/agent-session/agent-session-wire'
import { formatOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { idOf } from '../../../rpc/orchestration/callers/session.test-fixture'
import { sendChatTask } from '../../../rpc/methods/orchestration/chat-task-delivery'
import {
  isMailPointer,
  providerFaults,
  type FakeConnection
} from './structured-chat-coordinator-fake-codex-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  coordinatorRunAndTask,
  db,
  dispatcher,
  host,
  openChat,
  request,
  runtime,
  sendUserMessage,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

const WORKER = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))

/** A person's turn in `sessionId`, started and still running; resolves to its end. */
async function runningUserTurn(
  sessionId: string,
  chat: FakeConnection
): Promise<() => Promise<void>> {
  const index = chat.turns.length
  expect(await sendUserMessage(sessionId, 'go')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(index + 1), WAIT)
  const notify = (method: string, params: unknown) => chat.handlers.onNotification?.(method, params)
  notify('turn/started', { turn: { id: `turn-${index + 1}` } })
  notify('item/completed', {
    item: {
      type: 'userMessage',
      id: `echo-user-${index}`,
      clientId: chat.turns[index]!.clientUserMessageId,
      content: [{ type: 'text', text: 'go' }]
    }
  })
  await host.flushStreamedEvents(sessionId)
  return async () => {
    notify('turn/completed', { turn: { id: `turn-${index + 1}` } })
    await host.flushStreamedEvents(sessionId)
  }
}

async function refusal(method: string, params: Record<string, unknown>, sessionId?: string) {
  const response = await dispatcher.dispatch(
    request(method, params, sessionId ? { sessionId } : {})
  )
  if (response.ok) {
    throw new Error(`expected a refusal, got ${JSON.stringify(response)}`)
  }
  return response.error
}

/** Who each agent message in the chat's journal says it is from. */
async function taskSenders(sessionId: string): Promise<unknown[]> {
  return (await readTestHostJournal(host, sessionId)).items.flatMap((item) =>
    item.body.kind === 'message' && item.body.from ? [item.body.from] : []
  )
}

function dispatchCount(): unknown {
  return db.db.prepare('SELECT COUNT(*) AS n FROM dispatch_contexts').get()
}

describe('a chat as the assignee of orchestration dispatch', () => {
  it.each([false, true])(
    "shows a busy chat's full task with its sender, delivers only the pointer, and returns the task through check (Run-bound: %s)",
    async (runBound) => {
      await openChat(COORDINATOR)
      const worker = await openChat(PEER_CHAT)
      const { taskId } = await coordinatorRunAndTask()
      const workerRun = runBound
        ? idOf(
            (
              await call(
                'orchestration.runCreate',
                { objective: 'worker helpers' },
                { sessionId: PEER_CHAT }
              )
            ).run
          )
        : null
      const endTurn = await runningUserTurn(PEER_CHAT, worker)

      const result = await call(
        'orchestration.dispatch',
        { task: taskId, to: WORKER, inject: true },
        { sessionId: COORDINATOR }
      )

      expect(result).toMatchObject({ injected: true })
      const dispatchId = idOf(result.dispatch)
      expect(worker.turns).toHaveLength(1)
      const from = {
        kind: 'agent',
        senders: [
          {
            party: {
              address: formatOrcaSessionAddress(testOrcaSessionId(COORDINATOR)),
              terminalHandle: null,
              orcaSessionId: COORDINATOR
            }
          }
        ],
        orchestration: {
          message: 'mail-notice',
          mailbox: workerRun ? `run:${workerRun}` : `dispatch:${dispatchId}`,
          dispatchId: workerRun ? null : dispatchId
        }
      }
      await vi.waitFor(async () => expect(await queuedRows(PEER_CHAT)).toHaveLength(1), WAIT)
      const cards = await queuedRows(PEER_CHAT)

      await endTurn()
      await vi.waitFor(() => expect(worker.turns).toHaveLength(2), WAIT)
      expect(turnText(worker.turns[1]!)).toMatch(
        /^You have 1 orchestration message\. Run `orca(-dev)? orchestration check( --run \S+)?`\.$/
      )
      expect(worker.steers).toEqual([])
      expect(cards.map((card) => card.body.from)).toMatchObject([from])
      expect(JSON.stringify(cards)).toContain('build it')
      const checked = await call('orchestration.check', {}, { sessionId: PEER_CHAT })
      expect(checked).toMatchObject({
        count: 1,
        messages: [{ subject: 'Task', body: expect.stringContaining('=== TASK ===\nbuild it') }]
      })
      expect(await queuedCardTexts(PEER_CHAT)).toEqual([])
      expect(await taskSenders(PEER_CHAT)).toMatchObject([from])
    }
  )

  it('hands task mail to an adopted user chat before declaring it ready', async () => {
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'workspace-1',
      repoId: 'repo'
    } as never)

    const result = await call(
      'orchestration.workerStart',
      { task: taskId, terminal: WORKER },
      { sessionId: COORDINATOR }
    )

    expect(result).toMatchObject({ state: 'ready', turnStart: 'queued' })
    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    expect(isMailPointer(turnText(worker.turns[0]!))).toBe(true)
    expect(await call('orchestration.check', {}, { sessionId: PEER_CHAT })).toMatchObject({
      messages: [{ subject: 'Task', body: expect.stringContaining('=== TASK ===\nbuild it') }]
    })
  })

  it('queues one card for one Dispatch however often its task is sent', async () => {
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(PEER_CHAT, worker)
    const result = await call(
      'orchestration.dispatch',
      { task: taskId, to: WORKER },
      { sessionId: COORDINATOR }
    )
    const dispatch = db.getDispatchContextById(idOf(result.dispatch))!

    const from = { kind: 'agent' as const, senders: [], orchestration: null }
    const send = () => sendChatTask({ db, runtime, dispatch, from, preamble: 'the task' })
    expect(await send()).toBe('queued')
    expect(await send()).toBe('queued')

    await vi.waitFor(async () => {
      expect(await queuedRows(PEER_CHAT)).toMatchObject([
        { body: { blocks: [{ type: 'text', text: expect.stringContaining('the task') }] } }
      ])
    }, WAIT)
    expect(db.getUnreadMessages(`dispatch:${dispatch.id}`)).toHaveLength(1)
    await endTurn()
  })

  it('keeps the Dispatch open when the chat may have taken its task but never acknowledged it', async () => {
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    providerFaults.dieBeforeEveryEcho = true

    expect(
      await call(
        'orchestration.dispatch',
        { task: taskId, to: WORKER, inject: true },
        { sessionId: COORDINATOR }
      )
    ).toMatchObject({ injected: true })

    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    expect(db.db.prepare('SELECT status FROM dispatch_contexts').all()).toEqual([
      { status: 'dispatched' }
    ])
    expect(db.getTask(taskId)?.status).toBe('dispatched')
  })

  it('refuses a chat that was closed, with no row written', async () => {
    await openChat(COORDINATOR)
    await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    await host.setSessionTabVisibility(PEER_CHAT, false)

    const error = await refusal(
      'orchestration.dispatch',
      { task: taskId, to: WORKER, inject: true },
      COORDINATOR
    )

    expect(error).toMatchObject({
      code: 'session_caller_not_live',
      message: `Agent session ${PEER_CHAT} has ended: its chat was closed. No effects were applied.`
    })
    expect(dispatchCount()).toEqual({ n: 0 })
  })

  it("points the chat at its coordinator's Dispatch mail, which its own check reads once", async ({
    onTestFinished
  }) => {
    const accepted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let held = false
    onTestFinished(() => release.resolve())
    const observe = host.sendAnswer
    vi.spyOn(host, 'sendAnswer').mockImplementation(async (...args) => {
      const answer = await observe(...args)
      if (answer.kind === 'accepted' && !held) {
        held = true
        accepted.resolve()
        await release.promise
      }
      return answer
    })
    const settle = host.waitForSendSettlement
    vi.spyOn(host, 'waitForSendSettlement').mockImplementation(async (...args) => {
      const answer = await settle(...args)
      if (
        !held &&
        answer &&
        agentSessionSendSubmission(answer.value)?.dispatchState === 'accepted'
      ) {
        held = true
        accepted.resolve()
        await release.promise
      }
      return answer
    })
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { taskId } = await coordinatorRunAndTask()
    const result = await call(
      'orchestration.dispatch',
      { task: taskId, to: WORKER },
      { sessionId: COORDINATOR }
    )
    const dispatchId = idOf(result.dispatch)

    await call(
      'orchestration.send',
      { to: `dispatch:${dispatchId}`, subject: 'also check the tests' },
      { sessionId: COORDINATOR }
    )

    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    expect(isMailPointer(turnText(worker.turns[0]!))).toBe(true)
    expect(await queuedCardTexts(PEER_CHAT)).toEqual([])
    await settleTurn(PEER_CHAT, 0)
    await accepted.promise
    try {
      expect(await call('orchestration.check', {}, { sessionId: PEER_CHAT })).toMatchObject({
        messages: [{ subject: 'also check the tests' }]
      })
    } finally {
      release.resolve()
    }
    expect(await call('orchestration.check', {}, { sessionId: PEER_CHAT })).toMatchObject({
      messages: []
    })
  })
})
