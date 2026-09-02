/**
 * Incremental projection of durable agent inbox events.
 *
 * @module @deepseek-ai/dsh-agent/inbox
 */

import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEventMap, SurfaceIntent, UserMessage } from '@deepseek-ai/dsh-session'
import type { InboxAdmission, InboxTarget } from './types.ts'

/** Mutable state privately owned by an {@link Inbox}. */
type InboxState = Record<InboxTarget, UserMessage[]>

/** One claimed message plus its optional non-default Session placement. */
export interface ClaimedInboxMessage {
  readonly message: UserMessage
  readonly surfaceIntent?: SurfaceIntent
}

/** Live notifications committed by inbox mutations. */
export interface InboxNotifications {
  /** Publish one inserted message. */
  inserted(message: UserMessage): void
  /** Publish one discarded message. */
  discarded(message: UserMessage): void
  /** Publish one claimed message inside its owning turn. */
  claimed(message: UserMessage, turn: number): void
}

/** A replay-once projection that incrementally consumes later inbox splices. */
export class Inbox {
  private readonly state: InboxState = { 'next-turn': [], 'next-step': [] }
  private readonly admissions = new Map<MessageId, Omit<InboxAdmission, 'messageId'>>()

  constructor(
    private readonly session: Session,
    private readonly notifications: InboxNotifications,
  ) {
    for (const event of session.ownEvents()) {
      if (event.type !== 'agent/inbox/spliced') continue
      try {
        this.apply(event.data)
      } catch (error: unknown) {
        throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
      }
    }
  }

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.state['next-turn']
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.state['next-step']
  }

  /** Whether either pending-message list contains work. */
  get hasPending(): boolean {
    return this.nextTurn.length > 0 || this.nextStep.length > 0
  }

  /** Durably cancel all pending input, clearing next-step before next-turn. */
  clear(): void {
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /**
   * Remove and return the complete batch proposed for one step, publishing
   * each claimed message. The durable splices are pure deletions.
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   * @returns next-step input followed by the queued turn and any admission companions.
   * @internal - The agent loop's step-boundary operation, not a plugin extension point.
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    return this.claimWithIntents(target, turn).map(entry => entry.message)
  }

  /**
   * Remove the complete batch proposed for one step while retaining any
   * non-default Session placement carried by each message.
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   * @returns claimed primary messages with optional placement and expanded same-step companions.
   * @internal AgentLoop is the sole production consumer.
   */
  claimWithIntents(target: InboxTarget, turn: number): ClaimedInboxMessage[] {
    const claimedAdmissions = new Map<MessageId, Omit<InboxAdmission, 'messageId'>>()
    for (const message of this.nextStep) {
      const admission = this.admissions.get(message.id)
      if (admission !== undefined) claimedAdmissions.set(message.id, admission)
    }
    if (target === 'next-turn') {
      const message = this.nextTurn[0]
      const admission = message === undefined ? undefined : this.admissions.get(message.id)
      if (message !== undefined && admission !== undefined) claimedAdmissions.set(message.id, admission)
    }
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn') {
      claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    }
    const entries = claimed.flatMap((message): ClaimedInboxMessage[] => {
      const admission = claimedAdmissions.get(message.id)
      return [
        {
          message,
          ...(admission?.surfaceIntent === undefined ? {} : { surfaceIntent: admission.surfaceIntent }),
        },
        ...(admission?.followingMessages ?? []).map(following => ({ message: following })),
      ]
    })
    for (const { message } of entries) this.notifications.claimed(message, turn)
    return entries
  }

  /**
   * Append one message to a pending list and durably record the insertion.
   * @param target - pending list to extend.
   * @param message - message to append.
   * @param surfaceIntent - optional non-default Session placement retained through claim.
   * @throws if the message identity is already pending.
   */
  append(target: InboxTarget, message: UserMessage, surfaceIntent?: SurfaceIntent): void {
    this.splice(target, this.state[target].length, 0, [message], surfaceIntent === undefined
      ? []
      : [{ messageId: message.id, surfaceIntent }])
  }

  /**
   * Prepend one message to a pending list and durably record the insertion.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   * @param surfaceIntent - optional non-default Session placement retained through claim.
   * @throws if the message identity is already pending.
   */
  prepend(target: InboxTarget, message: UserMessage, surfaceIntent?: SurfaceIntent): void {
    this.splice(target, 0, 0, [message], surfaceIntent === undefined
      ? []
      : [{ messageId: message.id, surfaceIntent }])
  }

  /**
   * Replace one pending message in place, possibly changing its identity. A
   * successful replacement publishes the old message as discarded and the new
   * message as inserted.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   * @throws if the replacement duplicates another pending message identity.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    const admission = this.admissions.get(messageId)
    this.splice(location.target, location.index, 1, [newMessage], admission === undefined
      ? []
      : [{ messageId: newMessage.id, ...admission }])
    return true
  }

  /**
   * Remove one pending message and durably record its cancellation.
   * @param messageId - identity of the pending message to remove.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /**
   * Apply standard splice semantics and durably record the normalized result.
   * The durable event commits before the live projection mutates, so synchronous
   * `session/event` observers see the pre-splice lists and can reconstruct the
   * removed messages from the normalized coordinates.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @param admissions - optional metadata attached to identified inserted messages.
   * @returns messages removed by the splice.
   */
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    admissions: InboxAdmission[] = [],
  ): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true, admissions)
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = this.state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** Commit one normalized mutation and publish its live notifications. */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
    admissions: InboxAdmission[] = [],
  ): UserMessage[] {
    const inbox = this.state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    const splice = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(admissions.length === 0 ? {} : { admissions }),
      ...(outcome === undefined ? {} : { outcome }),
    }
    this.validate(splice)
    const event = this.session.append('agent/inbox/spliced', splice)
    const removed = inbox.splice(actualStart, actualDeleteCount, ...event.data.inserted)
    for (const message of removed) this.admissions.delete(message.id)
    for (const { messageId, ...admission } of event.data.admissions ?? []) {
      this.admissions.set(messageId, admission)
    }
    if (discardRemoved) {
      for (const message of removed) this.notifications.discarded(message)
    }
    for (const message of event.data.inserted) this.notifications.inserted(message)
    return removed
  }

  /** Apply one normalized durable splice to the projection. */
  private apply(splice: SessionEventMap['agent/inbox/spliced']): UserMessage[] {
    this.validate(splice)
    const inbox = this.state[splice.target]
    const removed = inbox.splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
    for (const message of removed) this.admissions.delete(message.id)
    for (const { messageId, ...admission } of splice.admissions ?? []) {
      this.admissions.set(messageId, admission)
    }
    return removed
  }

  /** Validate one normalized splice against the current projection. */
  private validate(splice: SessionEventMap['agent/inbox/spliced']): void {
    const inbox = this.state[splice.target]
    const removedCount = splice.removedCount ?? 0
    if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
      || !Number.isSafeInteger(removedCount) || removedCount < 0
      || splice.start + removedCount > inbox.length) {
      throw new Error('invalid inbox splice')
    }
    const candidate = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
    const ids = new Set<string>()
    for (const message of splice.target === 'next-turn'
      ? [...candidate, ...this.nextStep]
      : [...this.nextTurn, ...candidate]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
    const insertedIds = new Set(splice.inserted.map(message => message.id))
    const admissionIds = new Set<MessageId>()
    for (const entry of splice.admissions ?? []) {
      if (!insertedIds.has(entry.messageId)) {
        throw new Error(`admission message "${entry.messageId}" is not inserted by this splice`)
      }
      if (admissionIds.has(entry.messageId)) {
        throw new Error(`admission message "${entry.messageId}" is duplicated`)
      }
      if (entry.followingMessages !== undefined && !Array.isArray(entry.followingMessages)) {
        throw new Error(`admission message "${entry.messageId}" has invalid following messages`)
      }
      if (entry.surfaceIntent === undefined && (entry.followingMessages?.length ?? 0) === 0) {
        throw new Error(`admission message "${entry.messageId}" carries no metadata`)
      }
      admissionIds.add(entry.messageId)
    }
  }
}
