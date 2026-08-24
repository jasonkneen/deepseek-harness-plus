/**
 * ConnectionController: strict readiness handshake (describe + incremental
 * source ready), generation
 * abort on loss, backoff reconnection, state transitions, and sink-exception
 * isolation. Real (short) timers — the timeout and backoff are configurable,
 * so tests run them at millisecond scale.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from '../src/client/connection.ts'
import { ConnectionController } from '../src/client/connection.ts'
import { FakeApiClient, deferred, ok } from './fake-api.client.ts'

const FAST = { backoffBaseMs: 10, backoffFactor: 1, backoffMaxMs: 10, generationReadyTimeoutMs: 500 }

describe('connection lifecycle', () => {
  it('announces connected after describe plus generation readiness', async () => {
    const api = new FakeApiClient()
    const descriptions: boolean[] = []
    let connected = 0
    const controller = new ConnectionController(api, api.generation, {
      onConnected: (description) => {
        connected++
        descriptions.push(description.canOpenPath)
      },
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      expect(api.callsOf('host.describe')).toHaveLength(1)
      expect(descriptions).toEqual([true])
    } finally {
      controller.stop()
    }
  })

  it('reconnects with a fresh generation when its source fails, and stop() ends the loop', async () => {
    const api = new FakeApiClient()
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, api.generation, { onConnected: () => { connected++ } }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      api.failStreams(new Error('stream torn'))
      await vi.waitFor(() => { expect(connected).toBe(2) }) // new generation after backoff
      expect(api.openGenerationCount).toBe(1)
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
    // stop() aborts the live generation and no reconnect follows.
    await vi.waitFor(() => { expect(api.openGenerationCount).toBe(0) })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(api.openGenerationCount).toBe(0)
  })

  it('treats describe failure as generation failure and retries', async () => {
    const api = new FakeApiClient()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onDescribe']>>>()
    let describeCalls = 0
    api.onDescribe = () => {
      describeCalls++
      return describeCalls === 1 ? Promise.reject(new Error('host down')) : gate.promise
    }
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, api.generation, { onConnected: () => { connected++ } }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(describeCalls).toBe(2) }) // retried after backoff
      expect(connected).toBe(0) // never announced during the failed generation
      gate.resolve(ok({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true }))
      await vi.waitFor(() => { expect(connected).toBe(1) })
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it('treats a host.describe business error as generation failure', async () => {
    const api = new FakeApiClient()
    let describeCalls = 0
    api.onDescribe = () => {
      describeCalls += 1
      if (describeCalls === 1) {
        return Promise.resolve({
          rpcId: 'bad-describe' as never,
          result: {
            ok: false as const,
            error: { code: 'internal' as const, message: 'not ready', details: {} },
          },
        })
      }
      return Promise.resolve(ok({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true }))
    }
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, api.generation, { onConnected: () => { connected++ } }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(describeCalls).toBe(2) })
      await vi.waitFor(() => { expect(connected).toBe(1) })
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it('isolates a connected sink exception from the generation', async () => {
    const api = new FakeApiClient()
    let connected = 0
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, api.generation, {
      onConnected: () => {
        connected++
        throw new Error('business layer bug')
      },
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      expect(api.openGenerationCount).toBe(1)
      expect(errorSpy).toHaveBeenCalledWith('[connection] connection sink threw:', expect.any(Error))
    } finally {
      controller.stop()
      errorSpy.mockRestore()
    }
  })

  it('holds onConnected until the incremental source is ready after describe succeeds', async () => {
    const api = new FakeApiClient()
    api.holdGenerationReady = true
    let connected = 0
    const controller = new ConnectionController(api, api.generation, { onConnected: () => { connected++ } }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(api.callsOf('host.describe')).toHaveLength(1) })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(connected).toBe(0) // describe alone must not announce
      api.releaseGenerationReady()
      await vi.waitFor(() => { expect(connected).toBe(1) })
    } finally {
      controller.stop()
    }
  })

  it('rejects a generation whose source ends during readiness and retries', async () => {
    const api = new FakeApiClient()
    const firstDescribe = deferred<Awaited<ReturnType<FakeApiClient['onDescribe']>>>()
    let describeCalls = 0
    api.onDescribe = () => {
      describeCalls++
      return describeCalls === 1
        ? firstDescribe.promise
        : Promise.resolve(ok({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true }))
    }
    const states: ConnectionState[] = []
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, api.generation, {
      onConnected: () => { connected++ },
      onStateChange: state => states.push(state),
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(api.openGenerationCount).toBe(1) })
      api.endStreams()
      firstDescribe.resolve(ok({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true }))

      await vi.waitFor(() => { expect(describeCalls).toBe(2) })
      await vi.waitFor(() => { expect(connected).toBe(1) })
      expect(states).toEqual(['reconnecting', 'connected'])
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it.each([
    { label: 'ends normally', fail: () => Promise.resolve() },
    {
      label: 'rejects with a non-Error reason',
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- non-Error source normalization is the scenario.
      fail: () => Promise.reject('fixture offline'),
    },
  ])('retries when the generation source $label before reporting ready', async ({ fail }) => {
    const api = new FakeApiClient()
    let sourceCalls = 0
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, (signal, ready) => {
      sourceCalls++
      if (sourceCalls === 1) return fail()
      ready()
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }, { onConnected: () => { connected++ } }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(sourceCalls).toBe(2) })
      await vi.waitFor(() => { expect(connected).toBe(1) })
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it('rejects and retries a generation whose source never reports ready', async () => {
    const api = new FakeApiClient()
    api.suppressGenerationReady = true
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(
      api,
      api.generation,
      { onConnected: () => { connected++ } },
      { ...FAST, generationReadyTimeoutMs: 20 },
    )
    controller.start()
    try {
      await vi.waitFor(() => { expect(api.callsOf('host.describe').length).toBeGreaterThan(1) })
      expect(connected).toBe(0)
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it('emits deduplicated connected/reconnecting state transitions', async () => {
    const api = new FakeApiClient()
    const states: ConnectionState[] = []
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, api.generation, {
      onConnected: () => { connected++ },
      onStateChange: state => states.push(state),
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      expect(states).toEqual(['connected'])
      api.failStreams(new Error('torn'))
      await vi.waitFor(() => { expect(connected).toBe(2) })
      expect(states).toEqual(['connected', 'reconnecting', 'connected'])
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it('does not announce a generation stopped synchronously by its connected state sink', async () => {
    const api = new FakeApiClient()
    const states: ConnectionState[] = []
    let connected = 0
    const controller = new ConnectionController(api, api.generation, {
      onConnected: () => { connected++ },
      onStateChange: (state) => {
        states.push(state)
        if (state === 'connected') controller.stop()
      },
    }, FAST)

    controller.start()
    await vi.waitFor(() => { expect(states).toEqual(['connected']) })
    await vi.waitFor(() => { expect(api.openGenerationCount).toBe(0) })
    expect(connected).toBe(0)
  })

  it('deduplicates consecutive reconnecting emissions across two straight failures', async () => {
    const api = new FakeApiClient()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onDescribe']>>>()
    let describeCalls = 0
    api.onDescribe = () => {
      describeCalls++
      return describeCalls <= 2 ? Promise.reject(new Error('down')) : gate.promise
    }
    const states: ConnectionState[] = []
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(api, api.generation, {
      onConnected: () => { connected++ },
      onStateChange: state => states.push(state),
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(describeCalls).toBe(3) })
      gate.resolve(ok({ version: '0', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true }))
      await vi.waitFor(() => { expect(connected).toBe(1) })
      expect(states).toEqual(['reconnecting', 'connected']) // two failures, one reconnecting emission
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it('runs with no sinks at all (every callback slot optional)', async () => {
    const api = new FakeApiClient()
    const controller = new ConnectionController(api, api.generation, {}, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(api.callsOf('host.describe')).toHaveLength(1) })
      await new Promise(resolve => setTimeout(resolve, 20))
    } finally {
      controller.stop()
    }
  })

  it('start() is idempotent (one loop, one stream set)', async () => {
    const api = new FakeApiClient()
    let connected = 0
    const controller = new ConnectionController(api, api.generation, { onConnected: () => { connected++ } }, FAST)
    controller.start()
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      expect(api.openGenerationCount).toBe(1)
      expect(api.callsOf('host.describe')).toHaveLength(1)
    } finally {
      controller.stop()
    }
  })
})
