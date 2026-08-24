import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { ApiSessionNotFound } from '@deepseek-ai/dsh-api-session-controller'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-skill'
import { describe, expect, it, vi } from 'vitest'
import { createApiProxy } from '../src/api-proxy.ts'
import { RpcId } from '../src/api/rpc.ts'

describe('skill catalog Session inspection', () => {
  it('reads a detached Session without resuming its Agent', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const sessionId = SessionId('cold-skills')
    const resolveAgent = vi.fn()
    const inspect = vi.fn(() => Promise.resolve({
      meta: { version: 0 as const, id: sessionId, createdAt: 1, cwd: '/cold/project' },
      events: [],
    }))
    ctx.provide('sessionController', { inspect, resolveAgent } as never)
    const list = vi.fn(() => Promise.resolve([{
      name: 'review',
      description: 'Review the current change.',
      invocation: { modelInvocable: true, userInvocable: true },
    }]))
    ctx.provide('skills', { list } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
    })

    const response = await api.skills.list({ rpcId: RpcId('cold-skills'), payload: { sessionId } })

    expect(response.result).toEqual({
      ok: true,
      value: {
        skills: [{
          name: 'review',
          description: 'Review the current change.',
          modelInvocable: true,
        }],
      },
    })
    expect(inspect).toHaveBeenCalledWith(sessionId)
    expect(resolveAgent).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledWith({ cwd: '/cold/project', scope: undefined })
  })

  it('preserves missing and failed cold inspection as distinct API errors', async () => {
    const sessionId = SessionId('missing-skills')
    for (const fixture of [
      {
        error: new ApiSessionNotFound('session "missing-skills" not found'),
        code: 'session-not-found',
      },
      { error: new Error('storage offline'), code: 'internal' },
    ] as const) {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      ctx.provide('sessionController', {
        inspect: () => Promise.reject(fixture.error),
        resolveAgent: vi.fn(),
      } as never)
      ctx.provide('skills', { list: vi.fn() } as never)
      const api = createApiProxy(ctx, {
        defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
        cwd: '/default',
      })

      const response = await api.skills.list({ rpcId: RpcId(fixture.code), payload: { sessionId } })

      expect(response.result).toMatchObject({ ok: false, error: { code: fixture.code } })
    }
  })
})
