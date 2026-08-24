import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import { SessionHistoryController } from '../src/history.ts'

const signal = (): AbortSignal => new AbortController().signal

function append(
  session: Session,
  type: string,
  data: unknown,
  options?: { readonly surfaceOp?: unknown; readonly sourceEventSeqs?: readonly number[] },
): SessionEvent {
  return (session.append as unknown as (
    eventType: string,
    eventData: unknown,
    eventOptions?: unknown,
  ) => SessionEvent)(type, data, options)
}

function event(type: string, seq: number, data: unknown = {}): SessionEvent {
  return { type, seq, time: seq + 1, data } as SessionEvent
}

function cold(
  ctx: Context,
  header: SessionHeader,
  events: readonly SessionEvent[],
): void {
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([header]),
    inspect: () => Promise.resolve({ meta: header, events }),
  } as never)
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

async function setup(): Promise<{ ctx: Context; transport: SessionHistoryController }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const transport = new SessionHistoryController(ctx)
  return { ctx, transport }
}

describe('SessionHistoryController', () => {
  it('opens at the current cursor and follows later events from an ordinary Session', async () => {
    const { ctx, transport } = await setup()
    const session = ctx.sessions.create(SessionId('ordinary'), { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    const abort = new AbortController()
    const iterator = transport.follow(
      { address: { kind: 'session', sessionId: session.id } },
      abort.signal,
    )[Symbol.asyncIterator]()

    expect(await iterator.next()).toMatchObject({ done: false, value: { type: 'opened', cursor: 0 } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: 'event', event: { type: 'turn/end', seq: 1 } },
    })

    const page = await transport.page(
      { address: { kind: 'session', sessionId: session.id }, throughSeq: 1 },
      new AbortController().signal,
    )
    expect(page.events.map(entry => entry.event.seq)).toEqual([0, 1])

    abort.abort()
    expect(await iterator.next()).toMatchObject({ done: true })
  })

  it('ends active followers when the owning Controller unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let transport!: SessionHistoryController
    const owner = ctx.plugin(Object.assign(
      (inner: Context) => { transport = new SessionHistoryController(inner) },
      { inject: ['sessions'] },
    ))
    await owner.await()
    const session = ctx.sessions.create(SessionId('controller-unload'), { meta: { cwd: '/workspace' } })
    const iterator = transport.follow(
      { address: { kind: 'session', sessionId: session.id } },
      new AbortController().signal,
    )[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'opened', cursor: -1 },
    })
    const pending = iterator.next()
    await owner.dispose()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    await ctx.fiber.dispose()
  })

  it('resumes from the last applied seq before delivering later live events', async () => {
    const { ctx, transport } = await setup()
    const session = ctx.sessions.create(SessionId('resume'), { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    const abort = new AbortController()
    const iterator = transport.follow({
      address: { kind: 'session', sessionId: session.id },
      afterSeq: 0,
    }, abort.signal)[Symbol.asyncIterator]()

    expect(await iterator.next()).toEqual({ done: false, value: { type: 'opened', cursor: 2 } })
    expect(await iterator.next()).toMatchObject({ done: false, value: { type: 'event', event: { seq: 1 } } })
    expect(await iterator.next()).toMatchObject({ done: false, value: { type: 'event', event: { seq: 2 } } })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(await iterator.next()).toMatchObject({ done: false, value: { type: 'event', event: { seq: 3 } } })

    abort.abort()
    expect(await iterator.next()).toMatchObject({ done: true })
  })

  it('subscribes before a cold read and ignores unrelated and replayed buffered events', async () => {
    const { ctx, transport } = await setup()
    const sessionId = SessionId('cold-race')
    const header = { version: 0, id: sessionId, createdAt: 1, cwd: '/workspace' }
    const listed = deferred<readonly SessionHeader[]>()
    ctx.provide('sessionPersistence', {
      list: () => listed.promise,
      inspect: () => Promise.resolve({ meta: header, events: [event('fixture/start', 0)] }),
    } as never)
    const abort = new AbortController()
    const iterator = transport.follow({ address: { kind: 'session', sessionId } }, abort.signal)
      [Symbol.asyncIterator]()
    const opening = iterator.next()

    ctx.emit('session/event', { id: SessionId('unrelated') } as Session, event('fixture/other', 0))
    ctx.emit('session/event', { id: sessionId } as Session, event('fixture/start', 0))
    listed.resolve([header])
    await expect(opening).resolves.toEqual({ done: false, value: { type: 'opened', cursor: 0 } })

    const waiting = iterator.next()
    abort.abort()
    await expect(waiting).resolves.toMatchObject({ done: true })
  })

  it('bridges the unpublished end-seed boundary when a cold source attaches', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let transport!: SessionHistoryController
    let agentCtx!: Context
    await ctx.plugin(Object.assign(
      (inner: Context) => { transport = new SessionHistoryController(inner) },
      { inject: ['sessions'] },
    ))
    await ctx.plugin(Object.assign(
      (inner: Context) => { agentCtx = createScope(inner, { name: 'agent' }).ctx },
      { inject: ['sessions'] },
    ))
    const sessionId = SessionId('cold-attach')
    const header = { version: 0, id: sessionId, createdAt: 1, cwd: '/workspace' }
    const seed = [event('fixture/start', 0)]
    cold(ctx, header, seed)
    agentCtx.on('session/created', (session) => {
      if (session.id !== sessionId) return
      append(session, 'fixture/setup-one', {})
      append(session, 'fixture/setup-two', {})
    })
    const abort = new AbortController()
    const iterator = transport.follow({ address: { kind: 'session', sessionId } }, abort.signal)
      [Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'opened', cursor: 0 } })
    agentCtx.sessions.create(SessionId('unrelated-created'), { meta: { cwd: '/workspace' } })
    const attached = agentCtx.sessions.prepare(sessionId, { meta: header, seed })
    agentCtx.sessions.enter(attached)
    agentCtx.sessions.announce(attached)
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'event', event: { type: 'session/end-seed', seq: 1 } },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'event', event: { type: 'fixture/setup-one', seq: 2 } },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'event', event: { type: 'fixture/setup-two', seq: 3 } },
    })
    append(attached, 'fixture/live', {})
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'event', event: { type: 'fixture/live', seq: 4 } },
    })

    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })

  it('rejects gaps in replayed and live event sequences', async () => {
    const replay = await setup()
    const replayId = SessionId('replay-gap')
    const replayHeader = { version: 0, id: replayId, createdAt: 1, cwd: '/workspace' }
    cold(replay.ctx, replayHeader, [event('fixture/start', 0), event('fixture/gap', 2)])
    const replayed = replay.transport.follow({
      address: { kind: 'session', sessionId: replayId }, afterSeq: -1,
    }, signal())[Symbol.asyncIterator]()
    await expect(replayed.next()).resolves.toEqual({ done: false, value: { type: 'opened', cursor: 2 } })
    await expect(replayed.next()).resolves.toMatchObject({ done: false, value: { event: { seq: 0 } } })
    await expect(replayed.next()).rejects.toMatchObject({ failure: { code: 'internal' } })

    const live = await setup()
    const session = live.ctx.sessions.create(SessionId('live-gap'), { meta: { cwd: '/workspace' } })
    append(session, 'fixture/start', {})
    live.ctx.provide('agents', { get: () => ({ id: session.id }) } as never)
    const followed = live.transport.follow({
      address: { kind: 'session', sessionId: session.id },
    }, signal())[Symbol.asyncIterator]()
    await expect(followed.next()).resolves.toEqual({ done: false, value: { type: 'opened', cursor: 0 } })
    live.ctx.emit('session/event', session, event('fixture/gap', 2))
    await expect(followed.next()).rejects.toMatchObject({ failure: { code: 'internal' } })
  })

  it('opens an empty source at cursor -1', async () => {
    const { ctx, transport } = await setup()
    const session = ctx.sessions.create(SessionId('empty-follow'), { meta: { cwd: '/workspace' } })
    const abort = new AbortController()
    const iterator = transport.follow({
      address: { kind: 'session', sessionId: session.id },
    }, abort.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'opened', cursor: -1 } })
    await expect(transport.page({
      address: { kind: 'session', sessionId: session.id }, throughSeq: -1,
    }, signal())).resolves.toMatchObject({ events: [], hasMore: false })
    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })

  it('requires the durable parent and mode for a direct subagent address', async () => {
    const { ctx, transport } = await setup()
    const parentSessionId = SessionId('parent')
    const childSessionId = SessionId('child')
    ctx.sessions.create(parentSessionId, { meta: { cwd: '/workspace' } })
    const child = ctx.sessions.create(childSessionId, {
      meta: { cwd: '/workspace', origin: 'subagent', parentSession: parentSessionId },
    })
    child.append('subagent/descriptor', snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: 'test',
      label: 'child',
    }))
    const signal = new AbortController().signal

    await expect(transport.page({
      address: { kind: 'subagent', parentSessionId, childSessionId, mode: 'continuable' },
      throughSeq: 0,
    }, signal)).resolves.toMatchObject({ events: [{ event: { type: 'subagent/descriptor' } }] })
    await expect(transport.page({
      address: {
        kind: 'subagent',
        parentSessionId: SessionId('other-parent'),
        childSessionId,
        mode: 'continuable',
      },
      throughSeq: 0,
    }, signal)).rejects.toMatchObject({ failure: { code: 'subagent-unauthorized' } })
    await expect(transport.page({
      address: { kind: 'subagent', parentSessionId, childSessionId, mode: 'one-shot' },
      throughSeq: 0,
    }, signal)).rejects.toMatchObject({ failure: { code: 'subagent-unauthorized' } })
    await expect(transport.page({
      address: { kind: 'session', sessionId: childSessionId },
      throughSeq: 0,
    }, signal)).rejects.toMatchObject({ failure: { code: 'agent-busy' } })
  })

  it('preserves a cold inspection failure for the Gateway error branch', async () => {
    const { ctx, transport } = await setup()
    const sessionId = SessionId('corrupt-cold')
    const failure = new Error('cold log is corrupt')
    const header = { version: 0, id: sessionId, createdAt: 1, cwd: '/workspace' }
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([header]),
      inspect: () => Promise.reject(failure),
    } as never)

    await expect(transport.page({
      address: { kind: 'session', sessionId },
      throughSeq: -1,
    }, new AbortController().signal)).rejects.toBe(failure)
  })

  it('rejects malformed page and follow cursors at the service boundary', async () => {
    const { ctx, transport } = await setup()
    const session = ctx.sessions.create(SessionId('validation'), { meta: { cwd: '/workspace' } })
    const address = { kind: 'session' as const, sessionId: session.id }
    for (const request of [
      { address, throughSeq: -2 },
      { address, throughSeq: 0.5 },
      { address, throughSeq: -1, beforeSeq: -1 },
      { address, throughSeq: -1, beforeSeq: 1.5 },
      { address, throughSeq: -1, maxMessages: 0 },
      { address, throughSeq: -1, maxMessages: 1.5 },
    ]) {
      await expect(transport.page(request, signal())).rejects.toMatchObject({ failure: { code: 'bad-request' } })
    }
    await expect(transport.page({ address, throughSeq: 0 }, signal()))
      .rejects.toMatchObject({ failure: { code: 'bad-request' } })

    const corrupt = await setup()
    const corruptId = SessionId('missing-through-seq')
    cold(
      corrupt.ctx,
      { version: 0, id: corruptId, createdAt: 1, cwd: '/workspace' },
      [event('fixture/start', 0), event('fixture/gap', 2)],
    )
    await expect(corrupt.transport.page({
      address: { kind: 'session', sessionId: corruptId }, throughSeq: 1,
    }, signal())).rejects.toMatchObject({ failure: { code: 'internal' } })
    for (const afterSeq of [-2, 0.5]) {
      const iterator = transport.follow({ address, afterSeq }, signal())[Symbol.asyncIterator]()
      await expect(iterator.next()).rejects.toMatchObject({ failure: { code: 'bad-request' } })
    }
    const past = transport.follow({ address, afterSeq: 0 }, signal())[Symbol.asyncIterator]()
    await expect(past.next()).rejects.toMatchObject({ failure: { code: 'bad-request' } })
  })

  it('reports missing ordinary and subagent sources without fabricating inspection failures', async () => {
    const { ctx, transport } = await setup()
    const ordinary = { kind: 'session' as const, sessionId: SessionId('missing') }
    await expect(transport.page({ address: ordinary, throughSeq: -1 }, signal()))
      .rejects.toMatchObject({ failure: { code: 'internal' } })

    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([]),
      inspect: () => Promise.reject(new Error('must not inspect')),
    } as never)
    await expect(transport.page({ address: ordinary, throughSeq: -1 }, signal()))
      .rejects.toMatchObject({ failure: { code: 'session-not-found' } })
    await expect(transport.page({
      address: {
        kind: 'subagent',
        parentSessionId: SessionId('parent'),
        childSessionId: SessionId('missing-child'),
        mode: 'continuable',
      },
      throughSeq: -1,
    }, signal())).rejects.toMatchObject({ failure: { code: 'subagent-not-found' } })
  })

  it('rejects incomplete cold metadata before serving a source', async () => {
    const first = await setup()
    const sessionId = SessionId('incomplete')
    const address = { kind: 'session' as const, sessionId }
    first.ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([{ version: 0, id: sessionId, createdAt: 1 }]),
      inspect: () => Promise.reject(new Error('must not inspect')),
    } as never)
    await expect(first.transport.page({ address, throughSeq: -1 }, signal()))
      .rejects.toMatchObject({ failure: { code: 'session-not-found' } })

    const second = await setup()
    const listed = { version: 0, id: sessionId, createdAt: 1, cwd: '/workspace' }
    second.ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([listed]),
      inspect: () => Promise.resolve({ meta: { ...listed, cwd: undefined }, events: [] }),
    } as never)
    await expect(second.transport.page({ address, throughSeq: -1 }, signal()))
      .rejects.toMatchObject({ failure: { code: 'session-not-found' } })
  })

  it('serves cold ordinary history and validates every durable subagent descriptor state', async () => {
    const ordinaryBench = await setup()
    const ordinaryId = SessionId('cold-ordinary')
    const ordinaryHeader = { version: 0, id: ordinaryId, createdAt: 1, cwd: '/workspace' }
    cold(ordinaryBench.ctx, ordinaryHeader, [event('turn/start', 0, { turn: 1 })])
    await expect(ordinaryBench.transport.page({
      address: { kind: 'session', sessionId: ordinaryId },
      throughSeq: 0,
    }, signal())).resolves.toMatchObject({ events: [{ event: { seq: 0 } }] })

    const parentSessionId = SessionId('cold-parent')
    const childSessionId = SessionId('cold-child')
    const childHeader = {
      version: 0,
      id: childSessionId,
      createdAt: 1,
      cwd: '/workspace',
      origin: 'subagent' as const,
      parentSession: parentSessionId,
    }
    const childAddress = {
      kind: 'subagent' as const,
      parentSessionId,
      childSessionId,
      mode: 'continuable' as const,
    }
    const missing = await setup()
    cold(missing.ctx, childHeader, [])
    await expect(missing.transport.page({ address: childAddress, throughSeq: -1 }, signal()))
      .rejects.toMatchObject({ failure: { code: 'subagent-catalog-diagnostic', details: { reason: 'unsupported' } } })

    const corrupt = await setup()
    cold(corrupt.ctx, childHeader, [event('subagent/descriptor', 0, { version: 'bad' })])
    await expect(corrupt.transport.page({ address: childAddress, throughSeq: 0 }, signal()))
      .rejects.toMatchObject({ failure: { code: 'subagent-catalog-diagnostic', details: { reason: 'corrupt' } } })

    const ordinaryChild = await setup()
    const { origin: _origin, ...ordinaryChildHeader } = childHeader
    cold(ordinaryChild.ctx, ordinaryChildHeader, [])
    await expect(ordinaryChild.transport.page({ address: childAddress, throughSeq: -1 }, signal()))
      .rejects.toMatchObject({ failure: { code: 'subagent-unauthorized' } })
  })

  it('uses attached and detached projection cuts and isolates a child projection failure', async () => {
    const attached = await setup()
    const session = attached.ctx.sessions.create(SessionId('projected'), { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    const snapshot = vi.fn(() => ({ asOfSeq: 0, values: { title: 'attached' } }))
    attached.ctx.provide('sessionProjections', { snapshot, restore: vi.fn() } as never)
    await expect(attached.transport.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: 0,
    }, signal())).resolves.toMatchObject({ projections: { asOfSeq: 0, values: { title: 'attached' } } })
    expect(snapshot).toHaveBeenCalledWith(session)
    const older = await attached.transport.page({
      address: { kind: 'session', sessionId: session.id }, throughSeq: 0, beforeSeq: 1,
    }, signal())
    expect('projections' in older).toBe(false)

    const detached = await setup()
    const coldId = SessionId('projected-cold')
    const header = { version: 0, id: coldId, createdAt: 1, cwd: '/workspace' }
    cold(detached.ctx, header, [event('turn/start', 0, { turn: 1 })])
    const restore = vi.fn(() => ({ snapshot: { asOfSeq: 0, values: { title: 'cold' } } }))
    detached.ctx.provide('sessionProjections', { snapshot: vi.fn(), restore } as never)
    await expect(detached.transport.page({
      address: { kind: 'session', sessionId: coldId },
      throughSeq: 0,
    }, signal())).resolves.toMatchObject({ projections: { values: { title: 'cold' } } })
    expect(restore).toHaveBeenCalledWith({}, expect.any(Array), 0)

    const failed = await setup()
    cold(failed.ctx, header, [event('turn/start', 0, { turn: 1 })])
    failed.ctx.provide('sessionProjections', {
      snapshot: vi.fn(),
      restore: () => { throw new Error('projection failed') },
    } as never)
    await expect(failed.transport.page({
      address: { kind: 'session', sessionId: coldId },
      throughSeq: 0,
    }, signal())).rejects.toThrow('projection failed')

    const child = await setup()
    const parentSessionId = SessionId('projection-parent')
    const childSessionId = SessionId('projection-child')
    const childSession = child.ctx.sessions.create(childSessionId, {
      meta: { cwd: '/workspace', origin: 'subagent', parentSession: parentSessionId },
    })
    childSession.append('subagent/descriptor', snapshotSubagentDescriptor({
      mode: 'continuable', provider: 'test', label: 'child',
    }))
    const warn = vi.spyOn(child.ctx.logger, 'warn').mockImplementation(() => undefined)
    child.ctx.provide('sessionProjections', {
      snapshot: () => { throw new Error('child projection failed') },
      restore: vi.fn(),
    } as never)
    const page = await child.transport.page({
      address: { kind: 'subagent', parentSessionId, childSessionId, mode: 'continuable' },
      throughSeq: 0,
    }, signal())
    expect('projections' in page).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('child projection failed'))
  })

  it('resolves presenter scope from a live Agent or the durable preset and tolerates lookup failure', async () => {
    const live = await setup()
    const liveSession = live.ctx.sessions.create(SessionId('live-scope'), { meta: { cwd: '/workspace' } })
    const liveAgent = { id: liveSession.id }
    const preset = vi.fn(() => Promise.resolve('preset-scope'))
    live.ctx.provide('agents', { get: () => liveAgent } as never)
    live.ctx.provide('agentPresets', { standingKeyFor: preset } as never)
    await live.transport.page({
      address: { kind: 'session', sessionId: liveSession.id }, throughSeq: -1,
    }, signal())
    expect(preset).not.toHaveBeenCalled()

    const attached = await setup()
    const attachedSession = attached.ctx.sessions.create(SessionId('preset-scope'), {
      meta: { cwd: '/workspace', agentPreset: 'minimal' },
    })
    const standingKeyFor = vi.fn(() => Promise.resolve('standing-scope'))
    attached.ctx.provide('agentPresets', { standingKeyFor } as never)
    await attached.transport.page({
      address: { kind: 'session', sessionId: attachedSession.id },
      throughSeq: -1,
    }, signal())
    expect(standingKeyFor).toHaveBeenCalledWith('minimal')

    const detached = await setup()
    const detachedId = SessionId('detached-scope')
    const header = {
      version: 0, id: detachedId, createdAt: 1, cwd: '/workspace', agentPreset: 'standard',
    }
    cold(detached.ctx, header, [])
    const rejected = vi.fn(() => Promise.reject(new Error('preset unavailable')))
    detached.ctx.provide('agentPresets', { standingKeyFor: rejected } as never)
    await expect(detached.transport.page({
      address: { kind: 'session', sessionId: detachedId },
      throughSeq: -1,
    }, signal())).resolves.toMatchObject({ events: [] })
    expect(rejected).toHaveBeenCalledWith('standard')

    const switched = await setup()
    const switchedId = SessionId('switched-scope')
    const switchedHeader = {
      version: 0, id: switchedId, createdAt: 1, cwd: '/workspace', agentPreset: 'standard',
    }
    cold(switched.ctx, switchedHeader, [
      event('agent-preset/selected', 0, { agentPreset: 'minimal' }),
    ])
    const switchedKey = vi.fn(() => Promise.resolve('switched-scope'))
    switched.ctx.provide('agentPresets', { standingKeyFor: switchedKey } as never)
    await switched.transport.page({
      address: { kind: 'session', sessionId: switchedId }, throughSeq: 0,
    }, signal())
    expect(switchedKey).toHaveBeenCalledWith('minimal')
  })

  it('keeps message-aligned pagination contiguous across replacement provenance', async () => {
    const { ctx, transport } = await setup()
    const session = ctx.sessions.create(SessionId('pagination'), { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    append(session, 'user/message', { content: [], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const firstReply = append(session, 'assistant/message', { turn: 1, step: 1, message: {} }, { surfaceOp: 'append' })
    append(session, 'user/message', { content: [], source: { kind: 'user' } }, { surfaceOp: 'append' })
    append(session, 'assistant/message', { turn: 1, step: 2, message: {} }, { surfaceOp: 'append' })
    const summary = append(session, 'fixture/summary', {})
    const replacement = append(session, 'user/message', { content: [], source: { kind: 'plugin' } }, {
      surfaceOp: { op: 'replace', start: 1, end: 4 },
      sourceEventSeqs: [1, firstReply.seq, 3, 4, summary.seq],
    })

    const page = await transport.page({
      address: { kind: 'session', sessionId: session.id }, throughSeq: replacement.seq, maxMessages: 2,
    }, signal())
    expect(page.events.map(entry => entry.event.seq)).toEqual([3, 4, 5, replacement.seq])
    expect(page.hasMore).toBe(true)
    const before = await transport.page({
      address: { kind: 'session', sessionId: session.id }, throughSeq: replacement.seq, beforeSeq: 3, maxMessages: 1,
    }, signal())
    expect(before.events.map(entry => entry.event.seq)).toEqual([2])
  })

  it('keeps cited source events in the page that owns their appended message', async () => {
    const { ctx, transport } = await setup()
    const session = ctx.sessions.create(SessionId('pagination-sources'), { meta: { cwd: '/workspace' } })
    const source = append(session, 'fixture/source', {})
    append(session, 'user/message', { content: [], source: { kind: 'plugin' } }, {
      surfaceOp: 'append', sourceEventSeqs: [source.seq],
    })

    const page = await transport.page({
      address: { kind: 'session', sessionId: session.id }, throughSeq: 1, maxMessages: 1,
    }, signal())
    expect(page.events.map(entry => entry.event.seq)).toEqual([0, 1])
    expect(page.hasMore).toBe(false)
  })

  it('projects tool call and result views and contains malformed presenters', async () => {
    const { ctx, transport } = await setup()
    const sessionId = SessionId('presenters')
    const header = { version: 0, id: sessionId, createdAt: 1, cwd: '/workspace' }
    const events = [
      event('fixture/start', 0),
      event('tool/call', 1, { callId: 'c1', name: 'present', arguments: '{"path":"a.ts"}' }),
      event('tool/result', 2, {
        message: {
          source: { callId: 'c1' },
          content: [{ content: [{ type: 'text', text: 'ok' }], isError: true }],
        },
        meta: { persisted: true },
      }),
      event('tool/result', 3, {
        message: {
          source: { callId: 'missing' },
          content: [{ content: [{ type: 'text', text: 'missing' }] }],
        },
      }),
      event('tool/call', 4, { callId: 'c2', name: 'present', arguments: '{' }),
      event('tool/result', 5, {
        message: {
          source: { callId: 'c2' },
          content: [{ content: [{ type: 'text', text: 'bad args' }] }],
        },
      }),
      event('tool/call', 6, { callId: 'c3', name: 'empty', arguments: '{}' }),
      event('tool/result', 7, {
        message: {
          source: { callId: 'c3' },
          content: [{ content: [{ type: 'text', text: 'no presenter' }], isError: false }],
        },
      }),
      event('tool/call', 8, { callId: 'c4', name: 'throw-call', arguments: '{}' }),
      event('tool/call', 9, { callId: 'c5', name: 'throw-result', arguments: '{}' }),
      event('tool/result', 10, {
        message: {
          source: { callId: 'c5' },
          content: [{ content: [{ type: 'text', text: 'throw' }], isError: false }],
        },
      }),
    ]
    cold(ctx, header, events)
    ctx.provide('tools', {
      get: (name: string) => {
        if (name === 'present') {
          return {
            presentCall: (args: unknown) => ({ card: 'generic', title: 'Call', rawInput: args }),
            presentResult: (_args: unknown, result: unknown) => ({ card: 'generic', title: 'Result', result }),
          }
        }
        if (name === 'empty') return {}
        if (name === 'throw-call') return { presentCall: () => { throw new Error('call presenter failed') } }
        if (name === 'throw-result') return { presentResult: () => { throw new Error('result presenter failed') } }
        return undefined
      },
    } as never)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    const page = await transport.page({
      address: { kind: 'session', sessionId }, throughSeq: 10,
    }, signal())
    expect(page.events[1]?.view).toEqual({
      for: 'call', view: { card: 'generic', title: 'Call', rawInput: { path: 'a.ts' } },
    })
    expect(page.events[2]?.view).toMatchObject({ for: 'result', view: { card: 'generic', title: 'Result' } })
    for (const index of [0, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(page.events[index]).not.toHaveProperty('view')
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('call presenter failed'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('result presenter failed'))
  })
})
