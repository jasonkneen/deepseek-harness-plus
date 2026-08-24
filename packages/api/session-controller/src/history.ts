/** Cold Session history pagination and live-event source. */

import type { Context } from '@deepseek-ai/cordis'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SessionAddress,
  SessionEventEntry,
  SessionFollowRequest,
  SessionFollowFrame,
  SessionPage,
  SessionPageRequest,
  SessionProjectionsBlock,
  SessionProjectionValues,
  SessionWireEvent,
} from './types.ts'

const DEFAULT_MAX_MESSAGES = 50
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

type SessionSource =
  | { readonly kind: 'attached'; readonly session: Session }
  | { readonly kind: 'detached'; readonly header: SessionHeader; readonly events: readonly SessionEvent[] }

/** Implements cold-safe history operations delegated by the Session Controller. */
export class SessionHistoryController {
  private readonly closeFollowers = new Set<() => void>()

  /** @param ctx - Host context carrying Session, persistence, and projection services. */
  constructor(private readonly ctx: Context) {
    ctx.effect(() => () => {
      for (const close of this.closeFollowers) close()
      this.closeFollowers.clear()
    }, 'session-controller.history')
  }

  /**
   * Read one message-aligned history page without activating an Agent.
   * @param request - durable address and backwards-page cursor.
   * @param signal - caller cancellation for persistence reads.
   * @returns a contiguous event page and a projection baseline on tail reads.
   */
  async page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    validatePageRequest(request)
    const source = await this.sourceFor(request.address, signal)
    signal.throwIfAborted()
    const sourceLog = sourceEvents(source)
    const sourceCursor = sourceLog.at(-1)?.seq ?? -1
    if (request.throughSeq > sourceCursor) {
      reject(
        'bad-request',
        `session page through seq ${String(request.throughSeq)} is past cursor ${String(sourceCursor)}`,
        {},
      )
    }
    const events = sourceLog.filter(event => event.seq <= request.throughSeq)
    if ((events.at(-1)?.seq ?? -1) !== request.throughSeq) {
      reject('internal', `session log does not contain through seq ${String(request.throughSeq)}`, {})
    }
    const page = paginate(events, request.beforeSeq, request.maxMessages ?? DEFAULT_MAX_MESSAGES)
    const entries = page.events.map(entryFor)
    const projections = request.beforeSeq === undefined
      ? this.projectionsFor(request.address, source, events)
      : undefined
    return {
      events: entries,
      hasMore: page.hasMore,
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Follow events appended after an initial cursor on one durable address.
   * @param request - durable address and last committed sequence already held by the caller.
   * @param signal - stream cancellation owned by the Remote carrier.
   * @returns an opened cursor followed by gap-free event frames.
   */
  async *follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    validateFollowRequest(request)
    const { address, afterSeq } = request
    const target = addressId(address)
    const buffered: SessionEvent[] = []
    let wake: (() => void) | undefined
    const notify = (): void => {
      const resume = wake
      wake = undefined
      resume?.()
    }
    const follower = { closed: false }
    const close = (): void => {
      follower.closed = true
      notify()
    }
    this.closeFollowers.add(close)
    const disposeEvent = this.ctx.on('session/event', (session, event) => {
      if (session.id !== target) return
      buffered.push(event)
      notify()
    }, { global: true })
    const disposeCreated = this.ctx.on('session/created', (session) => {
      if (session.id !== target) return
      // Session construction appends session/end-seed before attachment, so the
      // marker has no session/event notification. Earlier session/created listeners
      // may publish later setup events first; this suffix must precede those notifications.
      const suffix = session.events.slice(session.firstLiveSeq)
      buffered.unshift(...suffix)
      notify()
    }, { global: true })
    const onAbort = (): void => { notify() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const source = await this.sourceFor(address, signal)
      const events = [...sourceEvents(source)]
      signal.throwIfAborted()
      const cursor = events.at(-1)?.seq ?? -1
      if (afterSeq !== undefined && afterSeq > cursor) {
        reject('bad-request', `session event resume seq ${String(afterSeq)} is past cursor ${String(cursor)}`, {})
      }
      let nextSeq = (afterSeq ?? cursor) + 1
      yield { type: 'opened', cursor }
      if (afterSeq !== undefined) {
        for (const event of events) {
          if (event.seq < nextSeq) continue
          if (event.seq !== nextSeq) {
            reject('internal', `session event replay skipped seq ${String(nextSeq)}`, {})
          }
          nextSeq++
          yield { type: 'event', ...entryFor(event) }
        }
      }
      while (!follower.closed && !signal.aborted) {
        const item = buffered.shift()
        if (item === undefined) {
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        if (item.seq < nextSeq) continue
        if (item.seq !== nextSeq) {
          reject('internal', `session event stream skipped seq ${String(nextSeq)}`, {})
        }
        nextSeq++
        yield { type: 'event', ...entryFor(item) }
      }
    } finally {
      this.closeFollowers.delete(close)
      signal.removeEventListener('abort', onAbort)
      disposeCreated()
      disposeEvent()
    }
  }

  private async sourceFor(address: SessionAddress, signal: AbortSignal): Promise<SessionSource> {
    const sessionId = addressId(address)
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      validateAddress(address, attached.header, attached.events)
      return { kind: 'attached', session: attached }
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      reject('internal', 'session persistence is not configured', {})
    }
    signal.throwIfAborted()
    const header = (await persistence.list(signal)).find(candidate => candidate.id === sessionId)
    if (header === undefined || header.cwd === undefined) rejectNotFound(address)
    const inspected: SessionInspection = await persistence.inspect(sessionId, signal)
    signal.throwIfAborted()
    if (inspected.meta.cwd === undefined) rejectNotFound(address)
    validateAddress(address, inspected.meta, inspected.events)
    return { kind: 'detached', header: inspected.meta, events: inspected.events }
  }

  private projectionsFor(
    address: SessionAddress,
    source: SessionSource,
    events: readonly SessionEvent[],
  ): SessionProjectionsBlock | undefined {
    const registry = this.ctx.get('sessionProjections')
    if (registry === undefined) return undefined
    try {
      const throughSeq = events.at(-1)?.seq ?? -1
      const snapshot = source.kind === 'attached' && source.session.seq - 1 === throughSeq
        ? registry.snapshot(source.session)
        : registry.restore({}, events, 0).snapshot
      return {
        asOfSeq: snapshot.asOfSeq,
        // Projection definitions validate whole JSON values before snapshot publication.
        values: snapshot.values as SessionProjectionValues,
      }
    } catch (error) {
      if (address.kind === 'session') throw error
      this.ctx.logger.warn(`session.page: projections for "${address.childSessionId}" failed: ${String(error)}`)
      return undefined
    }
  }
}

function validatePageRequest(request: SessionPageRequest): void {
  if (!Number.isSafeInteger(request.throughSeq) || request.throughSeq < -1) {
    reject('bad-request', 'throughSeq must be an integer greater than or equal to -1', {})
  }
  if (request.beforeSeq !== undefined
    && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0)) {
    reject('bad-request', 'beforeSeq must be a non-negative safe integer', {})
  }
  if (request.maxMessages !== undefined
    && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
    reject('bad-request', 'maxMessages must be a positive safe integer', {})
  }
}

function validateFollowRequest(request: SessionFollowRequest): void {
  if (request.afterSeq !== undefined
    && (!Number.isSafeInteger(request.afterSeq) || request.afterSeq < -1)) {
    reject('bad-request', 'afterSeq must be an integer greater than or equal to -1', {})
  }
}

function addressId(address: SessionAddress): SessionId {
  return address.kind === 'session' ? address.sessionId : address.childSessionId
}

function validateAddress(
  address: SessionAddress,
  header: SessionHeader,
  events: readonly SessionEvent[],
): void {
  if (address.kind === 'session') {
    if (header.origin === 'subagent') {
      reject('agent-busy', 'subagent Sessions require their durable parent address', {
        reason: 'use subagent delivery for this child session',
      })
    }
    return
  }
  if (header.origin !== 'subagent' || header.parentSession !== address.parentSessionId) {
    reject('subagent-unauthorized', 'subagent does not belong to the supplied parent', {
      childSessionId: address.childSessionId,
    })
  }
  let descriptor
  try {
    descriptor = foldSubagentDescriptor(events.slice(header.seedLength ?? 0))
  } catch {
    reject('subagent-catalog-diagnostic', 'subagent descriptor is corrupt', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'corrupt',
    })
  }
  if (descriptor === undefined) {
    reject('subagent-catalog-diagnostic', 'subagent descriptor is unavailable', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'unsupported',
    })
  }
  if (descriptor.mode !== address.mode) {
    reject('subagent-unauthorized', 'subagent mode does not match the supplied address', {
      childSessionId: address.childSessionId,
    })
  }
}

function rejectNotFound(address: SessionAddress): never {
  if (address.kind === 'session') {
    reject('session-not-found', `session "${address.sessionId}" not found`, { sessionId: address.sessionId })
  }
  reject('subagent-not-found', 'subagent is unavailable', {
    parentSessionId: address.parentSessionId,
    childSessionId: address.childSessionId,
  })
}

function reject(code: string, message: string, details: object): never {
  throw new TypertRemoteFailure({ code, message, details })
}

function sourceEvents(source: SessionSource): readonly SessionEvent[] {
  return source.kind === 'attached' ? source.session.events : source.events
}

function paginate(
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
): { readonly events: SessionEvent[]; readonly hasMore: boolean } {
  const window = beforeSeq === undefined ? [...events] : events.filter(event => event.seq < beforeSeq)
  let count = 0
  let cut = 0
  for (let index = window.length - 1; index >= 0; index--) {
    const event = window[index] as SessionEvent
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    const sources = (event as { readonly sourceEventSeqs?: readonly number[] }).sourceEventSeqs
    let groupStart = event.seq
    if (sources !== undefined) {
      for (const source of sources) groupStart = Math.min(groupStart, source)
    }
    if (count >= maxMessages) {
      cut = groupStart
      break
    }
  }
  return { events: window.filter(event => event.seq >= cut), hasMore: cut > 0 }
}

function entryFor(event: SessionEvent): SessionEventEntry {
  return {
    // Session.append validates and freezes event data as JSON before publication.
    event: event as unknown as SessionWireEvent,
  }
}
