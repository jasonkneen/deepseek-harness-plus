import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { RpcId } from '../src/api/rpc.ts'
import type { RpcRequest } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const sid = (value: string): SessionId => value as SessionId
const PARENT = sid('parent')
const CHILD = sid('child')

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('subagent-rpc'), payload }
}

function bench(options: {
  parentLive?: boolean
  childStatus?: 'idle' | 'running'
  entries?: object[]
  followupError?: Error
  interruptError?: Error
  listError?: Error
} = {}) {
  const parent = { id: PARENT }
  const child = options.childStatus === undefined
    ? undefined
    : { id: CHILD, status: options.childStatus }
  const getAgent = vi.fn((id: SessionId) => {
    if (options.parentLive !== false && id === PARENT) return parent
    if (id === CHILD) return child
    return undefined
  })
  const listChildren = vi.fn(() => options.listError === undefined
    ? Promise.resolve(options.entries ?? [
      {
        kind: 'child', id: CHILD, mode: 'continuable', label: 'worker',
        activity: 'inactive', hasChildren: false,
      },
    ])
    : Promise.reject(options.listError))
  const followup = vi.fn((
    _parent: unknown,
    _childId: SessionId,
    _content: unknown,
    _delivery: {
      source: { kind: string; rpcId: RpcId; clientTimeZone?: string }
      signal: AbortSignal
    },
  ) => options.followupError === undefined
    ? Promise.resolve('message-1')
    : Promise.reject(options.followupError))
  const interrupt = vi.fn((
    _targetSessionId: SessionId,
    _authority: { kind: 'user'; parentSessionId: SessionId },
  ) => {
    if (options.interruptError !== undefined) throw options.interruptError
  })
  const ctx = new Context()
  ctx.provide('agents', { get: getAgent })
  ctx.provide('subagents', { listChildren, followup, interrupt })
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp',
  })
  return { api, getAgent, listChildren, followup, interrupt, parent }
}

describe('subagent gateway', () => {
  it('lists the complete catalog and reports exact live-parent availability', async () => {
    const { api, listChildren } = bench({ parentLive: false, entries: [
      {
        kind: 'child', id: CHILD, mode: 'continuable', label: 'worker',
        activity: 'inactive', hasChildren: true,
      },
      {
        kind: 'child', id: sid('one-shot'), mode: 'one-shot',
        activity: 'inactive', hasChildren: false,
      },
      { kind: 'diagnostic', id: sid('bad'), reason: 'corrupt' },
    ] })
    const response = await api.subagents.list(request({ parentSessionId: PARENT }))
    expect(response.rpcId).toBe('subagent-rpc')
    expect(response.result).toMatchObject({
      ok: true,
      value: {
        parentAvailable: false,
        entries: [
          { kind: 'child', mode: 'continuable' },
          { kind: 'child', mode: 'one-shot' },
          { kind: 'diagnostic' },
        ],
      },
    })
    expect(listChildren).toHaveBeenCalledWith(PARENT, undefined)
  })

  it('derives catalog activity from the live child Agent rather than Session residency', async () => {
    const residentIdle = bench({ childStatus: 'idle', entries: [{
      kind: 'child', id: CHILD, mode: 'continuable', label: 'worker',
      activity: 'running', hasChildren: false,
    }] })
    expect((await residentIdle.api.subagents.list(request({ parentSessionId: PARENT }))).result)
      .toMatchObject({ ok: true, value: { entries: [{ activity: 'inactive' }] } })

    const running = bench({ childStatus: 'running' })
    expect((await running.api.subagents.list(request({ parentSessionId: PARENT }))).result)
      .toMatchObject({ ok: true, value: { entries: [{ activity: 'running' }] } })
  })

  it('maps the missing projections capability to one wire face on list and prompt', async () => {
    const listError = () => new SubagentError(
      'listing subagents requires the sessionProjections registry (load @deepseek-ai/dsh-session-projection)',
      'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE',
    )
    const expected = {
      code: 'internal',
      message: 'subagent catalog is unavailable: this deployment does not mount the sessionProjections registry (load @deepseek-ai/dsh-session-projection)',
    }

    const list = bench({ listError: listError() })
    expect((await list.api.subagents.list(request({ parentSessionId: PARENT }))).result)
      .toMatchObject({ ok: false, error: expected })

    const prompt = bench({ listError: listError() })
    expect((await prompt.api.subagents.prompt(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable', content: [],
    }), new AbortController().signal)).result).toMatchObject({ ok: false, error: expected })
    expect(prompt.followup).not.toHaveBeenCalled()
  })

  it('routes human content through the exact live parent with rpc attribution', async () => {
    const { api, parent, followup } = bench()
    const content = [{ type: 'text' as const, text: '继续' }]
    const signal = new AbortController().signal
    const response = await api.subagents.prompt(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable', content,
    }), signal)
    expect(response.result).toMatchObject({
      ok: true, value: { messageId: 'message-1' },
    })
    expect(followup).toHaveBeenCalledWith(
      parent,
      CHILD,
      content,
      { source: { kind: 'user', rpcId: RpcId('subagent-rpc') }, signal },
    )
  })

  it('canonicalizes browser-zone provenance before delivering a child prompt', async () => {
    const { api, parent, followup } = bench()
    const alias = 'US/Pacific'
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: alias })
      .resolvedOptions().timeZone
    const content = [{ type: 'text' as const, text: 'continue locally' }]
    const signal = new AbortController().signal
    await expect(api.subagents.prompt(request({
      parentSessionId: PARENT,
      childSessionId: CHILD,
      mode: 'continuable',
      content,
      clientTimeZone: alias,
    }), signal)).resolves.toMatchObject({ result: { ok: true } })
    expect(followup).toHaveBeenCalledWith(parent, CHILD, content, {
      source: { kind: 'user', rpcId: RpcId('subagent-rpc'), clientTimeZone: canonical },
      signal,
    })

    const invalid = await api.subagents.prompt(request({
      parentSessionId: PARENT,
      childSessionId: CHILD,
      mode: 'continuable',
      content,
      clientTimeZone: 'Not/A_Real_Zone',
    }), signal)
    expect(invalid.result).toEqual({
      ok: false,
      error: {
        code: 'invalid-time-zone',
        message: 'clientTimeZone must be UTC or a valid IANA Area/Location name',
        details: { value: 'Not/A_Real_Zone' },
      },
    })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('fails before delivery when the parent is absent and maps continuation failures', async () => {
    const absent = bench({ parentLive: false })
    expect((await absent.api.subagents.prompt(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable', content: [],
    }), new AbortController().signal)).result).toMatchObject({
      ok: false, error: { code: 'subagent-parent-unavailable' },
    })
    expect(absent.listChildren).not.toHaveBeenCalled()

    const failed = bench({ followupError: new SubagentError('draining', 'DRAINING') })
    expect((await failed.api.subagents.prompt(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable', content: [],
    }), new AbortController().signal)).result).toMatchObject({
      ok: false, error: { code: 'subagent-delivery-unavailable' },
    })
  })

  it('hides unexpected backend details', async () => {
    const catalog = bench({ listError: new Error('secret descriptor') })
    expect((await catalog.api.subagents.list(request({
      parentSessionId: PARENT,
    }))).result).toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'subagent catalog read failed' },
    })

    const prompt = bench({ followupError: new Error('secret provider') })
    expect((await prompt.api.subagents.prompt(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable', content: [],
    }), new AbortController().signal)).result).toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'subagent prompt failed' },
    })
  })

  it('interrupts through the core primitive alone while the parent Agent is offline', async () => {
    const { api, interrupt, getAgent, listChildren } = bench({ parentLive: false })
    const response = await api.subagents.interrupt(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable' as const,
    }))
    expect(response.rpcId).toBe('subagent-rpc')
    expect(response.result).toEqual({ ok: true, value: { accepted: true } })
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(CHILD, { kind: 'user', parentSessionId: PARENT })
    // No parent-registry or catalog dependency: this is what keeps a
    // live child interruptible after its parent Agent went offline.
    expect(getAgent).not.toHaveBeenCalled()
    expect(listChildren).not.toHaveBeenCalled()
  })

  it('maps interrupt authorization rejection without touching other services', async () => {
    const { api, listChildren } = bench({
      interruptError: new SubagentError('secret lineage', 'UNAUTHORIZED'),
    })
    const response = await api.subagents.interrupt(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable' as const,
    }))
    expect(response.result).toEqual({
      ok: false,
      error: {
        code: 'subagent-unauthorized',
        message: 'subagent does not belong to this parent',
        details: { childSessionId: CHILD },
      },
    })
    expect(listChildren).not.toHaveBeenCalled()
  })

  it('hides unexpected interrupt failures behind the internal code', async () => {
    const { api } = bench({ interruptError: new Error('secret activation state') })
    const response = await api.subagents.interrupt(request({
      parentSessionId: PARENT, childSessionId: CHILD, mode: 'continuable' as const,
    }))
    expect(response.result).toEqual({
      ok: false,
      error: { code: 'internal', message: 'subagent interrupt failed', details: {} },
    })
  })
})
