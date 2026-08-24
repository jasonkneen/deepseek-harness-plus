/**
 * Connection plugin browser-half apply: ctx.connection handle mounting, mode
 * selection off the page URL, and single-consumer connection-loop ownership.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  type ClientTransportHooks,
  type ConnectionGenerationSource,
  type ConnectionHandle,
} from '../src/client/index.ts'
import { FixtureApiClient } from '../src/client/fixture.ts'
import { WebApiClient } from '../src/client/web-api-client.ts'

type Win = {
  location?: { hostname: string; search: string; origin?: string }
  __DSH_TRANSPORT__?: ClientTransportHooks
}

afterEach(() => {
  delete (globalThis as Win).location
  delete (globalThis as Win).__DSH_TRANSPORT__
})

class GenerationProbe {
  private readonly active = new Set<() => void>()

  readonly source: ConnectionGenerationSource = (signal, ready) => new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', finish)
      this.active.delete(finish)
      resolve()
    }
    this.active.add(finish)
    signal.addEventListener('abort', finish, { once: true })
    ready()
    if (signal.aborted) finish()
  })

  end(): void {
    for (const finish of [...this.active]) finish()
  }
}

function installGeneration(handle: ConnectionHandle): GenerationProbe {
  const probe = new GenerationProbe()
  handle.registerGenerationSource(probe.source)
  return probe
}

async function mount(): Promise<ConnectionHandle> {
  const ctx = new Context()
  await ctx.plugin({ apply, inject: [] })
  const handle = ctx.get('connection') as ConnectionHandle | undefined
  if (handle === undefined) throw new Error('ctx.connection not provided')
  return handle
}

describe('connection client apply', () => {
  it('mounts ctx.connection with the real client when no ?fixture switch is present', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    const handle = await mount()
    expect(handle.api).toBeInstanceOf(WebApiClient)
    expect(handle.isLoopback).toBe(true)
  })

  it('selects the fixture client under ?fixture (and with no location at all stays real)', async () => {
    ;(globalThis as Win).location = { hostname: '127.0.0.1', search: '?fixture' }
    expect((await mount()).api).toBeInstanceOf(FixtureApiClient)
    delete (globalThis as Win).location
    const handle = await mount()
    expect(handle.api).toBeInstanceOf(WebApiClient)
    expect(handle.isLoopback).toBe(true)
  })

  it('reports non-loopback page authority through the connection handle', async () => {
    ;(globalThis as Win).location = { hostname: '192.0.2.20', search: '' }
    expect((await mount()).isLoopback).toBe(false)
  })

  it('requires one generation source and ignores a stale source disposer', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const first = new GenerationProbe()
    const second = new GenerationProbe()

    expect(() => handle.start({})).toThrow('no generation source is registered')
    const unregisterFirst = handle.registerGenerationSource(first.source)
    expect(() => { handle.registerGenerationSource(second.source) })
      .toThrow('a generation source is already registered')
    unregisterFirst()
    const unregisterSecond = handle.registerGenerationSource(second.source)
    unregisterFirst()

    const loop = handle.start({})
    await vi.waitFor(() => {
      expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
    })
    unregisterSecond()
    expect(handle.hostDescription.getSnapshot()).toBeUndefined()
    loop.stop()
  })

  it('start() hands out one loop, rejects a second consumer, and stop() aborts the generation', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    installGeneration(handle)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const descriptions: Array<boolean | undefined> = []
    const stopThrowing = handle.hostDescription.subscribe(() => { throw new Error('subscriber bug') })
    const stopDescription = handle.hostDescription.subscribe(() => {
      descriptions.push(handle.hostDescription.getSnapshot()?.canOpenPath)
    })
    expect(handle.hostDescription.getSnapshot()).toBeUndefined()
    // config omitted: the `config ?? {}` default arm is part of the surface.
    let connected = 0
    const loop = handle.start({ onConnected: () => { connected++ } })
    expect(() => handle.start({})).toThrow(/already owned by another consumer/)
    await vi.waitFor(() => {
      expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
    })
    loop.stop() // teardown must not throw; the fixture streams abort quietly
    expect(handle.hostDescription.getSnapshot()).toBeUndefined()
    expect(descriptions).toEqual([true, undefined])
    expect(connected).toBe(1)
    expect(errorSpy).toHaveBeenCalledTimes(2)
    stopThrowing()
    stopDescription()
    errorSpy.mockRestore()
  })

  it('allows a replacement owner and ignores the previous owner handle', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const generation = installGeneration(handle)

    const first = handle.start({})
    await vi.waitFor(() => {
      expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
    })
    first.stop()
    expect(handle.hostDescription.getSnapshot()).toBeUndefined()

    const second = handle.start({})
    await vi.waitFor(() => {
      expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
    })
    first.stop()
    expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)

    second.stop()
    generation.end()
  })

  it('does not announce a generation synchronously stopped by a description subscriber', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    installGeneration(handle)
    const owner: { loop?: ReturnType<ConnectionHandle['start']> } = {}
    let sawDescription = false
    const stopDescription = handle.hostDescription.subscribe(() => {
      if (handle.hostDescription.getSnapshot() === undefined) return
      sawDescription = true
      owner.loop?.stop()
    })
    const connected = vi.fn()
    const loop = handle.start({ onConnected: connected })
    owner.loop = loop
    try {
      await vi.waitFor(() => { expect(sawDescription).toBe(true) })
      expect(handle.hostDescription.getSnapshot()).toBeUndefined()
      expect(connected).not.toHaveBeenCalled()
    } finally {
      stopDescription()
      loop.stop()
    }
  })

  it('retracts the host description while reconnecting and republishes the next generation', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const generation = installGeneration(handle)
    const descriptions: Array<boolean | undefined> = []
    const reconnectSnapshots: Array<boolean | undefined> = []
    const stopDescription = handle.hostDescription.subscribe(() => {
      descriptions.push(handle.hostDescription.getSnapshot()?.canOpenPath)
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loop = handle.start({
      onStateChange: (state) => {
        if (state === 'reconnecting') {
          reconnectSnapshots.push(handle.hostDescription.getSnapshot()?.canOpenPath)
        }
      },
    }, { backoffBaseMs: 10, backoffFactor: 1, backoffMaxMs: 10, generationReadyTimeoutMs: 500 })
    try {
      await vi.waitFor(() => {
        expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
      })
      generation.end()

      await vi.waitFor(() => { expect(reconnectSnapshots).toEqual([undefined]) })
      await vi.waitFor(() => { expect(descriptions).toEqual([true, undefined, true]) })
      expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
    } finally {
      stopDescription()
      loop.stop()
      warnSpy.mockRestore()
    }
  })

  it('does not announce reconnecting after a description subscriber stops the loop', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const generation = installGeneration(handle)
    const owner: { loop?: ReturnType<ConnectionHandle['start']> } = {}
    let stoppedOnRetraction = false
    const stopDescription = handle.hostDescription.subscribe(() => {
      if (handle.hostDescription.getSnapshot() !== undefined || owner.loop === undefined) return
      stoppedOnRetraction = true
      owner.loop.stop()
    })
    const states: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loop = handle.start({
      onStateChange: (state) => { states.push(state) },
    }, { backoffBaseMs: 10, backoffFactor: 1, backoffMaxMs: 10, generationReadyTimeoutMs: 500 })
    owner.loop = loop
    try {
      await vi.waitFor(() => {
        expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
      })
      generation.end()

      await vi.waitFor(() => { expect(stoppedOnRetraction).toBe(true) })
      expect(handle.hostDescription.getSnapshot()).toBeUndefined()
      expect(states).toEqual(['connected'])
    } finally {
      stopDescription()
      loop.stop()
      warnSpy.mockRestore()
    }
  })

  it('WebApiClient keeps unary calls on globalThis.fetch', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    const handle = await mount()
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (input: URL | RequestInfo) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    try {
      // Schema rejection is fine — the transport hop is the assertion.
      await (handle.api as WebApiClient).host.describe({}).catch(() => undefined)
    } finally {
      globalThis.fetch = original
    }
    expect(seen.some(u => u.includes('/api/host.describe'))).toBe(true)
  })

  it('carries RPC calls without requiring secure-context randomUUID', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        return bytes.fill(0)
      },
    })
    const handle = await mount()
    const original = globalThis.fetch
    const seen: { url: string; body: unknown }[] = []
    globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (typeof init?.body !== 'string') throw new TypeError('expected a JSON string request body')
      const body = JSON.parse(init.body) as { rpcId: string }
      seen.push({ url, body })
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { ref: 'goal-1' } },
      })
    }
    try {
      await expect(handle.rpc.call('/api', 'goals/create', { args: { agentId: 'agent-1' } }))
        .resolves.toEqual({ ok: true, value: { ref: 'goal-1' } })
    } finally {
      globalThis.fetch = original
      vi.unstubAllGlobals()
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://dsh.internal/api/goals/create')
    expect(seen[0]?.body).toMatchObject({
      type: 'client-request',
      rpcId: '00000000-0000-4000-8000-000000000000',
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    })
  })

  it('exposes a worker-local Gateway stream through connection.rpc.open', async () => {
    ;(globalThis as Win).location = { hostname: 'preview.example', search: '' }
    const openStream = vi.fn<NonNullable<ClientTransportHooks['openStream']>>(
      (endpoint, payload, signal) => (async function *(): AsyncGenerator {
        signal.throwIfAborted()
        yield { endpoint, payload }
      })(),
    )
    ;(globalThis as Win).__DSH_TRANSPORT__ = {
      createApiClient: () => new FixtureApiClient(),
      fetch: vi.fn<ClientTransportHooks['fetch']>(),
      openStream,
      ownsHost: true,
    }
    const handle = await mount()
    const abort = new AbortController()
    const open = handle.rpc.open
    if (open === undefined) throw new Error('worker-local stream carrier was not installed')

    const values = []
    for await (const value of open('/api', 'session/follow', { args: { sessionId: 'session-1' } }, abort.signal)) {
      values.push(value)
    }
    expect(values).toEqual([{
      endpoint: 'session/follow', payload: { args: { sessionId: 'session-1' } },
    }])
    expect(openStream).toHaveBeenCalledWith(
      'session/follow',
      { args: { sessionId: 'session-1' } },
      abort.signal,
    )
    expect(handle.isLoopback).toBe(true)
    expect(() => open('/rpc', 'session/follow', {}, abort.signal))
      .toThrow('worker-local streams require the /api channel')
    expect(() => open('/api/path', 'session/follow', {}, abort.signal))
      .toThrow('invalid RPC target')
  })

  it('validates generic RPC transport failures, correlation, and targets', async () => {
    ;(globalThis as Win).location = {
      hostname: 'harness.example', search: '', origin: 'https://harness.example',
    }
    const handle = await mount()
    const original = globalThis.fetch
    const abort = new AbortController()
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }))
    try {
      await expect(handle.rpc.call('/api', 'goals/create', {}, abort.signal))
        .rejects.toThrow('HTTP 503')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        new URL('https://harness.example/api/goals/create'),
        expect.objectContaining({ signal: abort.signal }),
      )

      ;(globalThis as Win).location = { hostname: 'localhost', search: '', origin: 'null' }
      globalThis.fetch = vi.fn().mockResolvedValue(Response.json({
        type: 'server-response',
        rpcId: 'different-rpc',
        result: { ok: true, value: null },
      }))
      await expect(handle.rpc.call('/api', 'goals/create', {})).rejects.toThrow('rpcId mismatch')
      const fetch = vi.mocked(globalThis.fetch)
      expect(fetch.mock.calls[0]?.[0]).toEqual(new URL('http://dsh.internal/api/goals/create'))
      expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('signal')

      const respond = (result: unknown): void => {
        globalThis.fetch = async (_input: URL | RequestInfo, init?: RequestInit) => {
          if (typeof init?.body !== 'string') throw new TypeError('expected a JSON request body')
          const request = JSON.parse(init.body) as { rpcId: string }
          return Response.json({ type: 'server-response', rpcId: request.rpcId, result })
        }
      }
      for (const envelope of [
        null,
        { type: 'other', rpcId: 'rpc', result: { ok: true } },
        { type: 'server-response', rpcId: 1, result: { ok: true } },
      ]) {
        globalThis.fetch = vi.fn().mockResolvedValue(Response.json(envelope))
        await expect(handle.rpc.call('/api', 'goals/create', {}))
          .rejects.toThrow('invalid server-response envelope')
      }

      respond(null)
      await expect(handle.rpc.call('/api', 'goals/create', {}))
        .rejects.toThrow('invalid server-response result')
      respond({ ok: 'yes' })
      await expect(handle.rpc.call('/api', 'goals/create', {}))
        .rejects.toThrow('invalid server-response result')
      respond({ ok: false, error: null })
      await expect(handle.rpc.call('/api', 'goals/create', {}))
        .rejects.toThrow('invalid server-response result')

      for (const error of [
        { code: 1, message: 'failed', details: {} },
        { code: 'failed', message: 1, details: {} },
        { code: 'failed', message: 'failed', details: [] },
      ]) {
        respond({ ok: false, error })
        await expect(handle.rpc.call('/api', 'goals/create', {}))
          .rejects.toThrow('invalid server-response failure')
      }
      respond({
        ok: false,
        error: { code: 'fixture-failed', message: 'fixture rejected the call', details: { retry: false } },
      })
      await expect(handle.rpc.call('/api', 'goals/create', {})).resolves.toEqual({
        ok: false,
        error: { code: 'fixture-failed', message: 'fixture rejected the call', details: { retry: false } },
      })
    } finally {
      globalThis.fetch = original
    }

    for (const [channel, endpoint] of [
      ['api2', 'goals/create'],
      ['/api/path', 'goals/create'],
      ['/api', ''],
      ['/api', '.'],
      ['/api', '..'],
      ['/api', 'goals//create'],
      ['/api', 'goals/create?unsafe'],
    ] as const) {
      await expect(handle.rpc.call(channel, endpoint, {})).rejects.toThrow('invalid RPC target')
    }
  })

  it('carries Goal Remotes over the same state as the client-only fixture API', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const created = await handle.rpc.call('/api', 'goals/create', {
      args: { agentId: 'fx-alpha', request: { objective: 'fixture remote' } },
    })
    expect(created).toMatchObject({ ok: true, value: { ref: { revision: 1 } } })
    if (!created.ok) throw new Error('fixture Goal create failed')
    const ref = (created.value as { ref: { id: string; revision: number } }).ref
    const edited = await handle.rpc.call('/api', 'goals/edit', {
      args: { agentId: 'fx-alpha', ref, request: { objective: 'edited fixture remote' } },
    })
    expect(edited).toMatchObject({ ok: true, value: { objective: 'edited fixture remote', revision: 2 } })
    const editedRef = { id: ref.id, revision: 2 }
    const paused = await handle.rpc.call('/api', 'goals/pause', {
      args: { agentId: 'fx-alpha', ref: editedRef },
    })
    expect(paused).toMatchObject({ ok: true, value: { phase: 'paused', activation: 'disarmed', revision: 3 } })
    const resumed = await handle.rpc.call('/api', 'goals/resume', {
      args: { agentId: 'fx-alpha', ref: { id: ref.id, revision: 3 } },
    })
    expect(resumed).toMatchObject({ ok: true, value: { phase: 'active', activation: 'armed', revision: 4 } })
    const completed = await handle.rpc.call('/api', 'goals/complete', {
      args: { agentId: 'fx-alpha', ref: { id: ref.id, revision: 4 } },
    })
    expect(completed).toMatchObject({ ok: true, value: { phase: 'complete', activation: 'disarmed', revision: 5 } })
    await expect(handle.rpc.call('/api', 'goals/clear', {
      args: { agentId: 'fx-alpha', ref: { id: ref.id, revision: 5 } },
    })).resolves.toEqual({ ok: true, value: { id: ref.id, revision: 6 } })
    await expect(handle.rpc.call('/other', 'goals/create', {})).rejects.toThrow(/channel.*unavailable/)
    await expect(handle.rpc.call('/api', 'unknown/read', { args: { agentId: 'fx-alpha' } }))
      .rejects.toThrow(/endpoint.*unavailable/)
  })
})
