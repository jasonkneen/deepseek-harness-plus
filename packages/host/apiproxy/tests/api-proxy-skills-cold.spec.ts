import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
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
    const dispose = vi.fn()
    const observeSession = vi.fn(() => Promise.resolve({
      source: 'live',
      header: { version: 0 as const, id: sessionId, createdAt: 1, cwd: '/cold/project' },
      events: [],
      cursor: -1,
      projections: { asOfSeq: -1, values: {} },
      retain: () => { throw new Error('not retained') },
      [Symbol.dispose]: dispose,
    } satisfies SessionObservation))
    ctx.provide('sessionQuery', { observeSession } as never)
    ctx.provide('sessionController', { resolveAgent } as never)
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
    expect(observeSession).toHaveBeenCalledWith(sessionId)
    expect(dispose).toHaveBeenCalledOnce()
    expect(resolveAgent).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledWith({ cwd: '/cold/project', scope: undefined })
  })

  it('preserves missing and failed cold inspection as distinct API errors', async () => {
    const sessionId = SessionId('missing-skills')
    for (const fixture of [
      {
        error: new SessionQueryError(
          'session "missing-skills" not found',
          'SESSION_QUERY_SESSION_NOT_FOUND',
        ),
        code: 'session-not-found',
      },
      { error: new Error('storage offline'), code: 'internal' },
    ] as const) {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      ctx.provide('sessionQuery', {
        observeSession: () => Promise.reject(fixture.error),
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
