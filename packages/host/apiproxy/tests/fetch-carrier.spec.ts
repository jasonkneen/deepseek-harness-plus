import { describe, expect, it, vi } from 'vitest'
import type { ApiProxy } from '../src/api/index.ts'
import type { RpcMessage, RpcRequest } from '../src/api/rpc.ts'
import { toFetchHandler } from '../src/fetch/handler.ts'
import { AbstractApiClient, InProcessApiClient } from '../src/fetch/client.ts'

/** Minimal in-memory ApiProxy that echoes rpcIds. */
function fakeApi(overrides: Partial<{ crashOn: string }> = {}): ApiProxy {
  return {
    host: {
      async describe(request) {
        if (overrides.crashOn === 'host.describe') throw new Error('impl crashed')
        return {
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: { version: 'v', cwd: '/w', attachedSessions: 0, home: '/h', canOpenPath: true },
          },
        }
      },
      async openPath(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { opened: true as const } } }
      },
    },
    agentPresets: {
      openDocument(request: RpcRequest<{ agentPreset: string }>) {
        return Promise.resolve({ rpcId: request.rpcId, result: { ok: true as const, value: { opened: true as const } } })
      },
    },
    skills: {
      async list(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { skills: [{ name: 'commit-helper', description: 'Git commits', modelInvocable: true }] } } }
      },
    },
    settings: {
      async openDocument(request) {
        return { rpcId: request.rpcId, result: { ok: false, error: { code: 'internal', message: 'stub', details: {} } } }
      },
    },
    llm: {
      async providers(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { providers: [] } } }
      },
      async models(request) {
        return {
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: {
              default: { provider: 'test', model: 'test' },
              routableProviders: [],
              groups: [],
              failures: [],
            },
          },
        }
      },
      async discoverModels(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { models: [] } } }
      },
    },
    downloads: {
      async sessionLog() {
        return new Response('stub', { status: 404 })
      },
    },
  }
}

function client(api: ApiProxy = fakeApi(), timeoutMs?: number): InProcessApiClient {
  return new InProcessApiClient(toFetchHandler(api), timeoutMs)
}

describe('unary round trip (handler ⇄ client, no network)', () => {
  it('carries a success result and echoes the minted rpcId', async () => {
    const response = await client().host.describe({})
    expect(response.result).toMatchObject({ ok: true, value: { version: 'v', cwd: '/w' } })
    expect(response.rpcId).toMatch(/[0-9a-f-]{36}/)
  })

  it('carries a business error as 200 + error result', async () => {
    const response = await client().settings.openDocument({})
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) expect(response.result.error.code).toBe('internal')
  })

  it('round-trips the agent-preset document opener', async () => {
    // The opener is the domain's whole carried surface: its request schema is
    // registered in both halves, so a missing registration fails here rather
    // than in the browser.
    expect((await client().agentPresets.openDocument({ agentPreset: 'mine' })).result)
      .toEqual({ ok: true, value: { opened: true } })
  })

  it('round-trips host.openPath through the wire form', async () => {
    const api = fakeApi()
    let opened: string | undefined
    api.host.openPath = async (request) => {
      opened = request.payload.path
      return { rpcId: request.rpcId, result: { ok: true, value: { opened: true as const } } }
    }
    const response = await client(api).host.openPath({ path: '/tmp/a.txt' })
    expect(opened).toBe('/tmp/a.txt')
    expect(response.result).toEqual({ ok: true, value: { opened: true } })
  })

  it('round-trips skill.list through the wire form', async () => {
    const c = client()
    const skills = await c.skills.list({ sessionId: 's' as never })
    expect(skills.result).toEqual({ ok: true, value: { skills: [{ name: 'commit-helper', description: 'Git commits', modelInvocable: true }] } })
  })

  it('keeps caller and connection aborts on a signal-taking unary', async () => {
    const api = fakeApi()
    const started = Promise.withResolvers<AbortSignal>()
    api.host.openPath = async (request, signal) => {
      started.resolve(signal)
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }
      return {
        rpcId: request.rpcId,
        result: { ok: false, error: { code: 'cancelled', message: 'aborted', details: {} } },
      }
    }
    const controller = new AbortController()
    const execution = client(api).host.openPath({ path: '/tmp/a.txt' }, controller.signal)
    const handlerSignal = await started.promise

    controller.abort(new Error('connection closed'))

    await expect(execution).rejects.toThrow('connection closed')
    expect(handlerSignal.aborted).toBe(true)
  })

  it('propagates the carrier Request signal into host.openPath', async () => {
    const api = fakeApi()
    api.host.openPath = async (request, signal) => {
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }
      return {
        rpcId: request.rpcId,
        result: { ok: false, error: { code: 'cancelled', message: 'aborted', details: {} } },
      }
    }
    const handler = toFetchHandler(api)
    const controller = new AbortController()
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r-opener', method: 'host.openPath', payload: { path: '/tmp/a.txt' } })
    const pending = handler.fetch(new Request('http://x/api/host.openPath', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal,
    }))
    controller.abort()
    const parsed = await (await pending).json() as { result: { error?: { code: string } } }
    expect(parsed.result.error?.code).toBe('cancelled')
  })
})

describe('handler carrier-layer statuses', () => {
  const handler = toFetchHandler(fakeApi())

  it('404s unknown paths and non-POST non-stream methods', async () => {
    expect((await handler.fetch(new Request('http://x/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status).toBe(404)
    expect((await handler.fetch(new Request('http://x/api/host.describe', { method: 'GET' }))).status).toBe(404)
    expect((await handler.fetch(new Request('http://x/api/no.such', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'no.such', payload: {} }) }))).status).toBe(404)
  })

  it('400s a non-JSON body', async () => {
    const response = await handler.fetch(new Request('http://x/api/host.describe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }))
    expect(response.status).toBe(400)
  })

  it('rejects a malformed envelope with bad-request and the invalid-request sentinel rpcId', async () => {
    const response = await handler.fetch(new Request('http://x/api/host.describe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nope: true }) }))
    expect(response.status).toBe(200)
    const body = await response.json() as { rpcId: string; result: { ok: boolean; error?: { code: string } } }
    expect(body.rpcId).toBe('invalid-request')
    expect(body.result.error?.code).toBe('bad-request')
  })

  it('rejects a method/path mismatch echoing the envelope rpcId', async () => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r-9', method: 'host.describe', payload: {} })
    const response = await handler.fetch(new Request('http://x/api/skill.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
    const parsed = await response.json() as { rpcId: string; result: { error?: { message: string } } }
    expect(parsed.rpcId).toBe('r-9')
    expect(parsed.result.error?.message).toContain('does not match path')
  })

  it('rejects an invalid payload with the zod issues attached', async () => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r-10', method: 'host.openPath', payload: {} })
    const response = await handler.fetch(new Request('http://x/api/host.openPath', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
    const parsed = await response.json() as { result: { error?: { code: string; details: { issues: unknown[] } } } }
    expect(parsed.result.error?.code).toBe('bad-request')
    expect(parsed.result.error?.details.issues.length).toBeGreaterThan(0)
  })

  it('500s when the impl itself throws', async () => {
    const crashing = toFetchHandler(fakeApi({ crashOn: 'host.describe' }))
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r-11', method: 'host.describe', payload: {} })
    const response = await crashing.fetch(new Request('http://x/api/host.describe', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('impl crashed')
  })

  it('accepts (url, init) form fetch invocation', async () => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r-12', method: 'host.describe', payload: {} })
    const response = await handler.fetch('http://x/api/host.describe', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    expect(response.status).toBe(200)
  })
})

describe('client transport failures', () => {
  it('throws on a non-OK unary transport', async () => {
    const broken = new InProcessApiClient({ fetch: async () => new Response('down', { status: 503 }) })
    await expect(broken.host.describe({})).rejects.toThrow('transport failure for /api/host.describe: HTTP 503')
  })

  it('throws on an rpcId echo mismatch', async () => {
    const lying = new InProcessApiClient({
      fetch: async () => Response.json({
        type: 'server-response',
        rpcId: 'someone-else',
        result: { ok: true, value: { version: 'v', cwd: '/w', attachedSessions: 0, home: '/h', canOpenPath: true } },
      }),
    })
    await expect(lying.host.describe({})).rejects.toThrow('rpcId mismatch')
  })
})

describe('envelope observation', () => {
  it('batches envelopes per microtask and isolates a throwing listener', async () => {
    const c = client()
    const batches: (readonly RpcMessage[])[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unsubscribeThrowing = c.subscribeEnvelopes(() => { throw new Error('observer bug') })
    const unsubscribe = c.subscribeEnvelopes((batch) => { batches.push(batch) })
    await c.host.describe({})
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    // request and response tap in separate microtask windows (the await between
    // them yields), so both arrive but batch count is timing-defined
    expect(batches.flatMap(batch => batch.map(message => message.type))).toEqual(['client-request', 'server-response'])
    expect(errorSpy).toHaveBeenCalled()
    unsubscribe()
    unsubscribeThrowing()
    errorSpy.mockRestore()
  })

  it('skips buffering entirely with no listeners and after unsubscribe', async () => {
    const c = client()
    const seen: RpcMessage[] = []
    const unsubscribe = c.subscribeEnvelopes((batch) => { seen.push(...batch) })
    unsubscribe()
    await c.host.describe({})
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(seen).toHaveLength(0)
  })

  it('coalesces multiple calls in one microtask window into one flush', async () => {
    const c = client()
    const batches: (readonly RpcMessage[])[] = []
    c.subscribeEnvelopes((batch) => { batches.push(batch) })
    await Promise.all([c.host.describe({}), c.skills.list({ sessionId: 's1' as never })])
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const total = batches.reduce((n, batch) => n + batch.length, 0)
    expect(total).toBe(4)
  })
})

describe('resolveBase', () => {
  it('prefers a real location.origin and falls back to the internal authority', async () => {
    class Probe extends AbstractApiClient {
      urls: string[] = []
      protected async doFetch(input: URL): Promise<Response> {
        this.urls.push(input.href)
        return Response.json({
          type: 'server-response',
          rpcId: this.lastMinted,
          result: {
            ok: true,
            value: { version: 'v', cwd: '/w', attachedSessions: 0, home: '/h', canOpenPath: true },
          },
        })
      }

      lastMinted = ''
      protected override mintRpcId(): ReturnType<AbstractApiClient['mintRpcId']> {
        const id = super.mintRpcId()
        this.lastMinted = id
        return id
      }
    }
    const probe = new Probe()
    await probe.host.describe({})
    expect(probe.urls[0]).toMatch(/^http:\/\/dsh\.internal\//)

    const globalWithLocation = globalThis as { location?: { origin?: string } }
    globalWithLocation.location = { origin: 'http://host.example' }
    try {
      const probe2 = new Probe()
      await probe2.host.describe({})
      expect(probe2.urls[0]).toMatch(/^http:\/\/host\.example\//)
      globalWithLocation.location = { origin: 'null' } // sandboxed iframe shape
      const probe3 = new Probe()
      await probe3.host.describe({})
      expect(probe3.urls[0]).toMatch(/^http:\/\/dsh\.internal\//)
    } finally {
      delete globalWithLocation.location
    }
  })
})
