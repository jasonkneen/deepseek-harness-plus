import type { Inbox, InboxState, InboxTarget } from '@deepseek-ai/dsh-agent'
import { inboxProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEventMap, UserMessage } from '@deepseek-ai/dsh-session'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

/** A structural Inbox test double and its loop-driver operation. */
export interface InboxFixture {
  /** Session-backed Inbox exposed to the code under test. */
  readonly inbox: Inbox
  /** Remove the batch a test driver admits at one boundary. */
  readonly claim: (target: InboxTarget) => UserMessage[]
}

/**
 * Create a session-backed structural Inbox test double for consumer tests.
 * @param projections - registry that will own the fixture's standard inbox projection registration.
 * @param session - session whose durable splices back the test double.
 * @returns the structural Inbox and a separate loop-driver claim operation.
 */
export function createInboxFixture(
  projections: SessionProjectionRegistry,
  session: Session,
): InboxFixture {
  projections.register(inboxProjectionDefinition)

  const current = (): InboxState => {
    const state = projections.stateOf(session, 'inbox')
    /* v8 ignore next -- createInboxFixture holds the registration for the context lifetime */
    if (state === undefined) throw new Error('test inbox requires the standard inbox projection')
    return state
  }

  const locate = (messageId: MessageId): { target: InboxTarget; index: number } | undefined => {
    const state = current()
    const turnIndex = state['next-turn'].findIndex(message => message.id === messageId)
    if (turnIndex >= 0) return { target: 'next-turn', index: turnIndex }
    const stepIndex = state['next-step'].findIndex(message => message.id === messageId)
    return stepIndex < 0 ? undefined : { target: 'next-step', index: stepIndex }
  }

  const mutate = (
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    canceled: boolean,
  ): UserMessage[] => {
    const pending = current()[target]
    const integerStart = Number.isNaN(start) ? 0 : Math.trunc(start)
    const index = integerStart < 0
      ? Math.max(pending.length + integerStart, 0)
      : Math.min(integerStart, pending.length)
    const integerCount = Number.isNaN(deleteCount) ? 0 : Math.trunc(deleteCount)
    const count = Math.min(Math.max(integerCount, 0), pending.length - index)
    if (count === 0 && inserted.length === 0) return []
    const event: SessionEventMap['agent/inbox/spliced'] = {
      target,
      start: index,
      ...(count === 0 ? {} : { removedCount: count }),
      inserted,
      ...(canceled && count > 0 ? { outcome: 'canceled' } : {}),
    }
    const removed = pending.slice(index, index + count)
    session.append('agent/inbox/spliced', event)
    return removed
  }

  const inbox: Inbox = {
    get nextTurn() { return current()['next-turn'] },
    get nextStep() { return current()['next-step'] },
    clear() {
      mutate('next-step', 0, current()['next-step'].length, [], true)
      mutate('next-turn', 0, current()['next-turn'].length, [], true)
    },
    append(target, message) {
      mutate(target, current()[target].length, 0, [message], true)
    },
    prepend(target, message) {
      mutate(target, 0, 0, [message], true)
    },
    replace(messageId, message) {
      const location = locate(messageId)
      if (location === undefined) return false
      mutate(location.target, location.index, 1, [message], true)
      return true
    },
    remove(messageId) {
      const location = locate(messageId)
      if (location === undefined) return false
      mutate(location.target, location.index, 1, [], true)
      return true
    },
    splice(target, start, deleteCount, inserted) {
      return mutate(target, start, deleteCount, inserted, true)
    },
  }

  return {
    inbox,
    claim: (target) => {
      const claimed = mutate('next-step', 0, current()['next-step'].length, [], false)
      if (target === 'next-turn') claimed.push(...mutate('next-turn', 0, 1, [], false))
      return claimed
    },
  }
}
