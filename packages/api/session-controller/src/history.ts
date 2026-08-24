/** Cold Session history pagination and live-event source. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'
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
  SessionToolCallView,
  SessionToolView,
  SessionWireEvent,
} from './types.ts'

const DEFAULT_MAX_MESSAGES = 50
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

interface ToolCallData {
  readonly callId: string
  readonly name: string
  readonly arguments: string
}

type SessionSource =
  | { readonly kind: 'attached'; readonly session: Session }
  | { readonly kind: 'detached'; readonly header: SessionHeader; readonly events: readonly SessionEvent[] }

interface BufferedEvent {
  readonly session: Session
  readonly event: SessionEvent
}

/** Implements cold-safe history operations delegated by the Session Controller. */
export class SessionHistoryController {
  private readonly closeFollowers = new Set<() => void>()

  /** @param ctx - Host context carrying Session, persistence, presenter, and projection services. */
  constructor(private readonly ctx: Context) {
    ctx.effect(() => () => {
      for (const close of this.closeFollowers) close()
      this.closeFollowers.clear()
    }, 'session-controller.history')
  }

  /**
   * Read one message-aligned history page without activating an Agent.
   * @param request - durable address and backwards-page cursor.
   * @param signal - caller cancellation for persistence and preset reads.
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
    const scope = await this.presenterScopeFor(addressId(request.address), source, events)
    signal.throwIfAborted()
    const page = paginate(events, request.beforeSeq, request.maxMessages ?? DEFAULT_MAX_MESSAGES)
    const argsFor = (callId: string) => backscanArgs(page.events, callId)
    const entries = page.events.map(event => entryFor(this.ctx, event, argsFor, scope))
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
    const buffered: BufferedEvent[] = []
    const openCalls = new Map<string, { readonly name: string; readonly args: unknown }>()
    let fallbackEvents: readonly SessionEvent[] = []
    const argsFor = (callId: string): { readonly name: string; readonly args: unknown } | undefined => (
      openCalls.get(callId) ?? backscanArgs(fallbackEvents, callId)
    )
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
      buffered.push({ session, event })
      notify()
    }, { global: true })
    const disposeCreated = this.ctx.on('session/created', (session) => {
      if (session.id !== target) return
      // Session construction appends session/end-seed before attachment, so the
      // marker has no session/event notification. Earlier session/created listeners
      // may publish later setup events first; this suffix must precede those notifications.
      const suffix = session.events.slice(session.firstLiveSeq).map(event => ({ session, event }))
      buffered.unshift(...suffix)
      notify()
    }, { global: true })
    const onAbort = (): void => { notify() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const source = await this.sourceFor(address, signal)
      const events = [...sourceEvents(source)]
      fallbackEvents = events
      const scope = await this.presenterScopeFor(target, source, events)
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
          yield { type: 'event', ...entryFor(this.ctx, event, argsFor, scope) }
        }
      }
      while (!follower.closed && !signal.aborted) {
        const item = buffered.shift()
        if (item === undefined) {
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        if (item.event.seq < nextSeq) continue
        if (item.event.seq !== nextSeq) {
          reject('internal', `session event stream skipped seq ${String(nextSeq)}`, {})
        }
        nextSeq++
        if (item.event.type === 'tool/call') {
          const data = item.event.data as ToolCallData
          const call = parseToolCall(data)
          /* v8 ignore next -- malformed durable tool arguments intentionally skip the live presentation cache. */
          if (call !== undefined) openCalls.set(data.callId, call)
        } else if (item.event.type === 'turn/end') {
          openCalls.clear()
        }
        if (item.event.type === 'tool/result'
          && !openCalls.has(item.event.data.message.source.callId)) {
          fallbackEvents = item.session.events
        }
        const liveScope: Agent | undefined = this.ctx.get('agents')?.get(target)
        const entry = entryFor(this.ctx, item.event, argsFor, liveScope ?? scope)
        yield { type: 'event', ...entry }
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

  private async presenterScopeFor(
    sessionId: SessionId,
    source: SessionSource,
    events: readonly SessionEvent[],
  ): Promise<ScopeKey | undefined> {
    const live = this.ctx.get('agents')?.get(sessionId)
    if (live !== undefined) return live
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    const session = source.kind === 'attached'
      ? { header: source.session.header, events }
      : { header: source.header, events }
    try {
      return await presets.standingKeyFor(resolveSessionPreset(session))
    } catch {
      return undefined
    }
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

function entryFor(
  ctx: Context,
  event: SessionEvent,
  argsFor: (callId: string) => { readonly name: string; readonly args: unknown } | undefined,
  scope?: ScopeKey,
): SessionEventEntry {
  const view = viewFor(ctx, event, argsFor, scope)
  return {
    // Session.append validates and freezes event data as JSON before publication.
    event: event as unknown as SessionWireEvent,
    ...(view === undefined ? {} : { view }),
  }
}

function viewFor(
  ctx: Context,
  event: SessionEvent,
  argsFor: (callId: string) => { readonly name: string; readonly args: unknown } | undefined,
  scope?: ScopeKey,
): SessionToolView | undefined {
  if (event.type !== 'tool/call' && event.type !== 'tool/result') return undefined
  const tools = ctx.get('tools')
  /* v8 ignore next -- deployments without the optional Tools service omit presentation metadata. */
  if (tools === undefined) return undefined
  try {
    if (event.type === 'tool/call') {
      const data = event.data as ToolCallData
      const view: ToolCallView | undefined = tools.get(data.name, scope)?.presentCall?.(JSON.parse(data.arguments))
      return view === undefined ? undefined : { for: 'call', view: jsonView(view) }
    }
    const [result] = event.data.message.content
    const call = argsFor(event.data.message.source.callId)
    if (call === undefined) return undefined
    const view: ToolResultView | undefined = tools.get(call.name, scope)?.presentResult?.(call.args, {
      content: result.content,
      isError: result.isError === true,
      ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
    })
    return view === undefined ? undefined : { for: 'result', view: jsonView(view) }
  } catch (error) {
    ctx.logger.warn(`session: presenter failed for ${event.type}: ${String(error)}`)
  }
  return undefined
}

function backscanArgs(
  events: readonly SessionEvent[],
  callId: string,
): { readonly name: string; readonly args: unknown } | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as SessionEvent
    if (event.type !== 'tool/call') continue
    const data = event.data as ToolCallData
    if (data.callId !== callId) continue
    return parseToolCall(data)
  }
  return undefined
}

function parseToolCall(data: ToolCallData): { readonly name: string; readonly args: unknown } | undefined {
  try {
    return { name: data.name, args: JSON.parse(data.arguments) }
  } catch {
    return undefined
  }
}

function jsonView(view: ToolCallView): SessionToolCallView
function jsonView(view: ToolResultView): ToolResultView
function jsonView(view: ToolCallView | ToolResultView): SessionToolCallView | ToolResultView {
  const encoded = JSON.stringify(view)
  return JSON.parse(encoded) as SessionToolCallView | ToolResultView
}
