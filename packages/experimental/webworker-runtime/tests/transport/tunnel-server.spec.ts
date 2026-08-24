import { describe, expect, it, vi } from 'vitest'
import type { TunnelOutboundFrame } from '../../src/transport/frames.ts'
import { TunnelServer, type TunnelSeams } from '../../src/transport/tunnel.ts'

function harness(): { server: TunnelServer; frames: TunnelOutboundFrame[] } {
  const frames: TunnelOutboundFrame[] = []
  const server = new TunnelServer({
    port: { postMessage: (frame) => { frames.push(frame) } },
    requestListener: () => Promise.reject(new Error('fixture has no HTTP listener')),
  })
  return { server, frames }
}

function seams(openStream: TunnelSeams['openStream']): TunnelSeams {
  return {
    directFetch: () => Promise.reject(new Error('fixture has no direct fetch')),
    bootPayload: () => ({}),
    openStream,
    streamFailure: error => ({
      code: 'fixture-stream-failed',
      message: error instanceof Error ? error.message : String(error),
      details: { fixture: true },
    }),
  }
}

describe('worker tunnel logical streams', () => {
  it('drains a pre-boot open through the worker-local Gateway seam', async () => {
    const { server, frames } = harness()
    const seen: unknown[] = []
    server.handleMessage({
      t: 'stream-open', id: 1, endpoint: 'session/follow', payload: { args: { sessionId: 'session-1' } },
    })
    expect(frames).toEqual([])

    server.serve(seams(async (endpoint, payload, signal) => {
      seen.push(endpoint, payload, signal)
      return (async function *(): AsyncGenerator {
        yield { type: 'baseline' }
        yield { type: 'event', seq: 1 }
      })()
    }))

    await vi.waitFor(() => {
      expect(frames).toEqual([
        { t: 'stream-item', id: 1, value: { type: 'baseline' } },
        { t: 'stream-item', id: 1, value: { type: 'event', seq: 1 } },
        { t: 'stream-end', id: 1 },
      ])
    })
    expect(seen).toEqual([
      'session/follow',
      { args: { sessionId: 'session-1' } },
      expect.any(AbortSignal),
    ])
  })

  it('cancels one logical stream without emitting a terminal frame', async () => {
    const { server, frames } = harness()
    const opened = Promise.withResolvers<AbortSignal>()
    const stopped = Promise.withResolvers<undefined>()
    server.serve(seams(async (_endpoint, _payload, signal) => {
      opened.resolve(signal)
      return (async function *(): AsyncGenerator {
        yield 'ready'
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        stopped.resolve(undefined)
      })()
    }))
    server.handleMessage({ t: 'stream-open', id: 2, endpoint: '$events', payload: { args: {} } })
    const signal = await opened.promise
    await vi.waitFor(() => { expect(frames).toContainEqual({ t: 'stream-item', id: 2, value: 'ready' }) })

    server.handleMessage({ t: 'abort', id: 2 })
    await stopped.promise
    expect(signal.aborted).toBe(true)
    expect(frames).toEqual([{ t: 'stream-item', id: 2, value: 'ready' }])
  })

  it('maps a Host stream failure through Gateway-owned fields', async () => {
    const { server, frames } = harness()
    server.serve(seams(async () => { throw new Error('Host stream exploded') }))
    server.handleMessage({ t: 'stream-open', id: 3, endpoint: 'probe/watch', payload: {} })

    await vi.waitFor(() => {
      expect(frames).toEqual([{
        t: 'stream-error',
        id: 3,
        failure: {
          kind: 'remote',
          code: 'fixture-stream-failed',
          message: 'Host stream exploded',
          details: { fixture: true },
        },
      }])
    })
  })

  it('refuses queued and future streams after boot failure as carrier failures', () => {
    const { server, frames } = harness()
    server.handleMessage({ t: 'stream-open', id: 4, endpoint: '$events', payload: {} })
    server.fail(new Error('image failed'))
    server.handleMessage({ t: 'stream-open', id: 5, endpoint: '$events', payload: {} })

    expect(frames).toEqual([4, 5].map(id => ({
      t: 'stream-error',
      id,
      failure: { kind: 'carrier', message: 'Error: image failed' },
    })))
  })
})
