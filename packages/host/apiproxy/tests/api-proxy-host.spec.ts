import { homedir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

let nextRpc = 1
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`host-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: { readonly result: { readonly ok: true; readonly value: T } | { readonly ok: false } }): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

async function harness(
  extras: {
    openPath?: (path: string, signal: AbortSignal) => Promise<void>
    canOpenPath?: () => boolean
  } = {},
) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: '/tmp/dsh-apiproxy-host',
    ...extras.openPath === undefined ? {} : { openPath: extras.openPath },
    ...extras.canOpenPath === undefined ? {} : { canOpenPath: extras.canOpenPath },
  })
  return { api }
}

describe('host.openPath', () => {
  it('describes whether the deployment can reach a native desktop', async () => {
    const visible = await harness({ canOpenPath: () => true })
    const headless = await harness({ canOpenPath: () => false })
    expect(expectOk(await visible.api.host.describe(request({}))).canOpenPath).toBe(true)
    expect(expectOk(await headless.api.host.describe(request({}))).canOpenPath).toBe(false)
    expect(expectOk(await visible.api.host.describe(request({}))).home).toBe(homedir())
  })

  it('opens through the injected native boundary', async () => {
    const opened: string[] = []
    const { api } = await harness({
      openPath: async (path) => { opened.push(path) },
    })
    expect((await api.host.openPath(
      request({ path: '/tmp/a.txt' }),
      new AbortController().signal,
    )).result).toEqual({ ok: true, value: { opened: true } })
    expect(opened).toEqual(['/tmp/a.txt'])
  })

  it('propagates abort into the native boundary as a cancelled RPC error', async () => {
    const { api } = await harness({
      openPath: (_path, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }),
    })
    const abort = new AbortController()
    const pending = api.host.openPath(request({ path: '/tmp/a.txt' }), abort.signal)
    abort.abort()
    expect((await pending).result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })
})
