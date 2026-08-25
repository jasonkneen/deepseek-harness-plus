/** API Proxy behavior for Agent preset management and preset-scoped catalogs. */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentFactory } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { RpcId, type RpcRequest } from '../src/api/rpc.ts'
import type { ApiProxy } from '../src/api/index.ts'
import {
  agentPresetProjectionDefinition, InvalidPresetIdError, PresetExistsError, UnknownPresetError,
} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import { GoalId } from '@deepseek-ai/dsh-goal'
import { createApiProxy } from '../src/api-proxy.ts'
import { describe, expect, it } from 'vitest'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'

let nextRpc = 0
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`preset-${String(nextRpc++)}`), payload }
}

const sessionHarnesses = new WeakMap<ApiProxy, { ctx: Context; cwd: string }>()

async function createSession(
  api: ApiProxy,
  request: { readonly sessionId: SessionId; readonly agentPreset?: string },
): Promise<void> {
  const harness = sessionHarnesses.get(api)
  if (harness === undefined) throw new Error('Session test harness is not installed')
  const presets = harness.ctx.get('agentPresets')
  const agentPreset = presets === undefined
    ? undefined
    : (await presets.resolve(request.agentPreset)).id
  await harness.ctx.agents.create({
    sessionId: request.sessionId,
    meta: {
      cwd: harness.cwd,
      ...(agentPreset === undefined ? {} : { agentPreset }),
    },
    ...(agentPreset === undefined || presets === undefined
      ? {}
      : { setup: async (agentCtx: Context) => { await presets.mount(agentCtx, agentPreset) } }),
  })
}

/** Minimal live agent; the gateway only needs identity and its session. */
function stubAgent(session: Session): Agent {
  return { id: session.id, session, status: 'idle' } as unknown as Agent
}

/**
 * A roster whose `mount` is a no-op: this spec is about the gateway's identity
 * rules, and the composition itself is covered by the real-composition test in
 * `apps/cli`. Ids listed in `userIds` present as locally authored; the rest
 * ship with the deployment.
 */
function roster(ids: readonly string[], userIds: readonly string[] = []): unknown {
  const trustOf = (id: string): 'system' | 'user' => (userIds.includes(id) ? 'user' : 'system')
  const presetOf = (id: string): object =>
    ({ id, trust: trustOf(id), path: `/presets/${id}/agent.cordis.yml` })
  return {
    defaultId: ids[0],
    list: () => Promise.resolve(ids.map(presetOf)),
    resolve: (id?: string) => {
      const wanted = id ?? ids[0] ?? ''
      if (!ids.includes(wanted)) return Promise.reject(new UnknownPresetError(wanted, ids))
      return Promise.resolve(presetOf(wanted))
    },
    mount: (_ctx: Context, id?: string) => Promise.resolve(presetOf(id ?? ids[0] ?? '')),
    // What a real mount leaves behind: a service instance only the agent that
    // mounted it can be used to address. The doubles are per agent so a test
    // can tell "this session's" from "some session's".
    serviceFor: (agent: { id: unknown }, name: string) => {
      const perAgent = services.get(String(agent.id))
      return perAgent?.[name]
    },
    authorable: true,
    read: (id: string) => Promise.resolve(`# ${id}\n- id: x\n  name: y\n`),
    copy: (from: string, id: string) => {
      if (!ids.includes(from)) return Promise.reject(new UnknownPresetError(from, ids))
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return Promise.reject(new InvalidPresetIdError(id))
      if (ids.includes(id)) return Promise.reject(new PresetExistsError(id))
      return Promise.resolve()
    },
    remove: (id: string) => {
      if (!ids.includes(id)) return Promise.reject(new UnknownPresetError(id, ids))
      return Promise.resolve()
    },
    recompose: (_ctx: Context, id: string) => {
      if (!ids.includes(id)) return Promise.reject(new UnknownPresetError(id, ids))
      return Promise.resolve({ id, trust: 'system', path: `/presets/${id}.yml` })
    },
    // The standing scope key a cold transcript read resolves presenters in.
    standingKeyFor: (id?: string) => {
      const wanted = id ?? ids[0] ?? ''
      if (!ids.includes(wanted)) return Promise.reject(new UnknownPresetError(wanted, ids))
      let key = standingKeys.get(wanted)
      if (key === undefined) {
        key = { agentPreset: wanted }
        standingKeys.set(wanted, key)
      }
      return Promise.resolve(key)
    },
  }
}

/** Standing keys minted by the roster double. */
const standingKeys = new Map<string, object>()

/** Per-agent service instances a mounted preset would own, keyed by session id. */
const services = new Map<string, Record<string, unknown>>()

async function harness(
  presets?: readonly string[],
  options: { userIds?: readonly string[]; defaults?: Record<string, unknown> } = {},
) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-preset-')))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  if (presets !== undefined) ctx.provide('agentPresets', roster(presets, options.userIds) as never)
  ctx.provide('sessionQuery', {
    observeSession: (sessionId: SessionId) => {
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) {
        return Promise.reject(new SessionQueryError(
          `session "${sessionId}" not found`,
          'SESSION_QUERY_SESSION_NOT_FOUND',
        ))
      }
      let preset = agentPresetProjectionDefinition.init(session.header)
      for (const event of session.events) {
        preset = agentPresetProjectionDefinition.apply(preset, event)
      }
      const events = Object.freeze([...session.events])
      const lease = (): SessionObservation => ({
        source: 'live' as const,
        header: session.header,
        events,
        cursor: events.at(-1)?.seq ?? -1,
        projections: {
          asOfSeq: events.at(-1)?.seq ?? -1,
          values: { agentPreset: preset },
        },
        retain: lease,
        [Symbol.dispose]: () => {},
      })
      return Promise.resolve(lease())
    },
  } as never)

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      // Setup runs before publication against a context that carries the
      // agent, and the agent reaches back through `agent.ctx` — the pair the
      // gateway's own `installTarget` relies on.
      const agentCtx = ctx.extend({ agent })
      ;(agent as { ctx?: Context }).ctx = agentCtx
      await options.setup?.(agentCtx)
      const unregister = ctx.agents.register(agent)
      return { agent, dispose: () => { unregister(); return Promise.resolve() } }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  ctx.provide('sessionController', {
    resolveAgent: (sessionId: SessionId) => {
      const agent = ctx.agents.get(sessionId)
      return Promise.resolve(agent === undefined
        ? {
          error: {
            code: 'session-not-found',
            message: `session "${sessionId}" not found`,
            details: { sessionId },
          },
        }
        : { agent })
    },
    inspect: (sessionId: SessionId) => {
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) throw new Error(`session "${sessionId}" not found`)
      return Promise.resolve({ meta: session.header, events: [...session.events] })
    },
  } as never)
  const defaults = {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd,
    ...options.defaults,
  }
  const api = createApiProxy(ctx, defaults)
  sessionHarnesses.set(api, { ctx, cwd })
  return { api, ctx, cwd }
}

/**
 * A capability a preset mounts is reachable from nowhere the host normally
 * looks: an `isolate` realm is what makes it per session. The gateway serves
 * requests that are ABOUT a session from OUTSIDE it, so it addresses the
 * instance through the agent instead of reading a root-realm singleton.
 */
describe('a capability the session\'s preset mounts', () => {
  it('serves the goal RPC from the session\'s own goal service', async () => {
    const { api } = await harness(['standard'])
    await createSession(api, { sessionId: SessionId('g1'), agentPreset: 'standard' })
    const ref = { id: GoalId('goal-1'), revision: 1 }
    const paused: unknown[] = []
    services.set('g1', {
      goals: { pause: (agent: { id: unknown }, r: unknown) => { paused.push([String(agent.id), r]); return ref } },
    })

    const response = await api.goals.pause(request({ sessionId: SessionId('g1'), ref }))

    expect(response.result).toMatchObject({ ok: true, value: { ref } })
    // Reached the instance this session mounted, and was handed its own agent.
    expect(paused).toEqual([['g1', ref]])
    services.delete('g1')
  })

  it('serves the skill catalog from the session\'s own registry', async () => {
    const { api } = await harness(['standard'])
    await createSession(api, { sessionId: SessionId('k1'), agentPreset: 'standard' })
    services.set('k1', {
      skills: {
        list: () => Promise.resolve([{
          name: 'preset-owned',
          description: 'ships inside the preset directory',
          invocation: { modelInvocable: true, userInvocable: true },
        }]),
      },
    })

    const response = await api.skills.list(request({ sessionId: SessionId('k1') }))

    // A preset ships its own skill directory, so the catalog IS the
    // session's; reading a host singleton would answer for the wrong one.
    expect(response.result).toMatchObject({ ok: true, value: { skills: [{ name: 'preset-owned' }] } })
    services.delete('k1')
  })

  it('says so when no composition mounts the capability at all', async () => {
    const { api } = await harness(['standard'])
    await createSession(api, { sessionId: SessionId('n1'), agentPreset: 'standard' })

    const response = await api.skills.list(request({ sessionId: SessionId('n1') }))

    // Absent means absent — not "this session has none", which is what a
    // root-realm read used to report for every presetd session.
    expect(response.result.ok).toBe(false)
    const failure = response.result as { ok: false; error: { message: string } }
    expect(failure.error.message).toContain('neither this session')
  })
})

describe('agentPreset.list', () => {
  it('marks the default and carries each preset\'s trust', async () => {
    const { api } = await harness(['standard', 'minimal'])

    const response = await api.agentPresets.list(request({}))

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.presets).toEqual([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'minimal', trust: 'system', isDefault: false },
    ])
    expect(response.result.value.authorable).toBe(true)
  })

  it('answers with an empty roster when the deployment composes no presets', async () => {
    const { api } = await harness()

    const response = await api.agentPresets.list(request({}))

    // Composing no presets is a valid deployment, not an error: every session
    // then shares the host composition and the browser offers no choice.
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.presets).toEqual([])
    // Nothing to write to either, so a surface offering "new preset" knows to
    // stay hidden rather than offering a button whose save always fails.
    expect(response.result.value.authorable).toBe(false)
  })
})

describe('agentPreset.select', () => {
  it('recomposes a blank session', async () => {
    const { api } = await harness(['standard', 'minimal'])
    await createSession(api, { sessionId: SessionId('sel-1'), agentPreset: 'standard' })

    const response = await api.agentPresets.select(
      request({ sessionId: SessionId('sel-1'), agentPreset: 'minimal' }))

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.agentPreset).toBe('minimal')
  })

  it('records the switch in the log', async () => {
    const { api, ctx } = await harness(['standard', 'minimal'])
    await createSession(api, { sessionId: SessionId('sel-log'), agentPreset: 'standard' })

    await api.agentPresets.select(
      request({ sessionId: SessionId('sel-log'), agentPreset: 'minimal' }))

    // The header is written once at creation, so the switch lives in the log —
    // this is what a restart replays and what every projection resolves from.
    // Asserting only the RPC's echo would miss a switch that never persisted.
    const session = ctx.sessions.get(SessionId('sel-log'))
    if (session === undefined) throw new Error('unreachable')
    expect(session.header.agentPreset).toBe('standard')
    expect(session.events.findLast(event => event.type === 'agent-preset/selected')?.data)
      .toEqual({ agentPreset: 'minimal' })
  })

  it('serializes two concurrent selects on one session', async () => {
    const { api, ctx } = await harness(['standard', 'minimal'])
    await createSession(api, { sessionId: SessionId('sel-race'), agentPreset: 'standard' })

    // Both pass the blank check; unserialized, the second unmount finds no
    // record because the first already removed it, and two compositions end up
    // in one agent layer. The client's busy flag is not enforcement.
    const [first, second] = await Promise.all([
      api.agentPresets.select(request({ sessionId: SessionId('sel-race'), agentPreset: 'minimal' })),
      api.agentPresets.select(request({ sessionId: SessionId('sel-race'), agentPreset: 'standard' })),
    ])

    expect(first.result.ok).toBe(true)
    expect(second.result.ok).toBe(true)
    const session = ctx.sessions.get(SessionId('sel-race'))
    if (session === undefined) throw new Error('unreachable')
    // One winner, and the log agrees with it: the last committed switch.
    expect(session.events.findLast(event => event.type === 'agent-preset/selected')?.data)
      .toEqual({ agentPreset: 'standard' })
  })

  it('refuses once the conversation has started', async () => {
    const { api, ctx } = await harness(['standard', 'minimal'])
    await createSession(api, { sessionId: SessionId('sel-2'), agentPreset: 'standard' })
    // One turn is enough: the history from here on was produced under
    // `standard`'s tools, and a swap would strand those tool calls.
    ctx.sessions.get(SessionId('sel-2'))?.append('turn/start', { turn: 0 })

    const response = await api.agentPresets.select(
      request({ sessionId: SessionId('sel-2'), agentPreset: 'minimal' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-locked')
  })

  it('reports an unknown preset without disturbing the session', async () => {
    const { api } = await harness(['standard'])
    await createSession(api, { sessionId: SessionId('sel-3') })

    const response = await api.agentPresets.select(
      request({ sessionId: SessionId('sel-3'), agentPreset: 'nope' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-not-found')
  })

  it('reports a deployment that composes no presets', async () => {
    const { api } = await harness()
    await createSession(api, { sessionId: SessionId('sel-4') })

    const response = await api.agentPresets.select(
      request({ sessionId: SessionId('sel-4'), agentPreset: 'anything' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-not-found')
  })
})

describe('authoring over the wire', () => {
  it('reads a composition with its trust', async () => {
    const { api } = await harness(['standard'])

    const response = await api.agentPresets.read(request({ agentPreset: 'standard' }))

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    // The shipped set is readable: it is the known-good composition a copy
    // starts from, and trust is what tells a surface to say so.
    expect(response.result.value.trust).toBe('system')
    expect(response.result.value.content).toContain('- id: x')
  })

  it('copies a preset under a new id', async () => {
    const { api } = await harness(['standard'])

    const response = await api.agentPresets.copy(
      request({ from: 'standard', agentPreset: 'mine', name: '我的模式' }))

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.agentPreset).toBe('mine')
  })

  it('rejects a copy target that could escape the preset root', async () => {
    const { api } = await harness(['standard'])

    const response = await api.agentPresets.copy(request({ from: 'standard', agentPreset: '../escape' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-invalid')
  })

  it('rejects a copy target the roster already supplies', async () => {
    const { api } = await harness(['standard', 'minimal'])

    const response = await api.agentPresets.copy(request({ from: 'standard', agentPreset: 'minimal' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-invalid')
    expect(response.result.error.message).toMatch(/already exists/)
  })

  it('rejects a copy whose source is unknown', async () => {
    const { api } = await harness(['standard'])

    const response = await api.agentPresets.copy(request({ from: 'never-existed', agentPreset: 'mine' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-not-found')
  })

  it('reports a deployment that composes no presets', async () => {
    const { api } = await harness()

    const response = await api.agentPresets.read(request({ agentPreset: 'anything' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-not-found')
  })

  it('reports an unknown id on delete rather than succeeding silently', async () => {
    const { api } = await harness(['standard'])

    const response = await api.agentPresets.remove(request({ agentPreset: 'never-existed' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-not-found')
  })
})

describe('opening a preset directory', () => {
  it('hands the resolved directory to the native opener', async () => {
    const opened: string[] = []
    const { api } = await harness(['standard', 'my-preset'], {
      userIds: ['my-preset'],
      defaults: { openPath: (path: string) => { opened.push(path); return Promise.resolve() } },
    })

    const response = await api.agentPresets.openDocument(
      request({ agentPreset: 'my-preset' }), new AbortController().signal)

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value).toEqual({ opened: true })
    // The id selected the directory; the browser supplied no path.
    expect(opened).toEqual(['/presets/my-preset'])
  })

  it('answers the path as text where the deployment has no opener', async () => {
    const { api } = await harness(['standard', 'my-preset'], {
      userIds: ['my-preset'],
      defaults: { canOpenPath: () => false },
    })

    const response = await api.agentPresets.openDocument(
      request({ agentPreset: 'my-preset' }), new AbortController().signal)

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value).toEqual({ opened: false, path: '/presets/my-preset' })
  })

  it('refuses a preset that ships with the deployment', async () => {
    const opened: string[] = []
    const { api } = await harness(['standard'], {
      defaults: { openPath: (path: string) => { opened.push(path); return Promise.resolve() } },
    })

    const response = await api.agentPresets.openDocument(
      request({ agentPreset: 'standard' }), new AbortController().signal)

    // Pointing an editor into the install invites edits an upgrade will
    // silently overwrite; the refusal mirrors copy/remove.
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-read-only')
    expect(opened).toEqual([])
  })

  it('reports the roster capability on list', async () => {
    const openable = await harness(['standard'], {
      defaults: { canOpenPath: () => true },
    })
    const headless = await harness(['standard'], {
      defaults: { canOpenPath: () => false },
    })

    const yes = await openable.api.agentPresets.list(request({}))
    const no = await headless.api.agentPresets.list(request({}))

    expect(yes.result.ok && yes.result.value.hasDocument).toBe(true)
    expect(no.result.ok && no.result.value.hasDocument).toBe(false)
  })

  it('counts an injected opener as openable', async () => {
    const { api } = await harness(['standard'], {
      defaults: { openPath: () => Promise.resolve() },
    })

    const response = await api.agentPresets.list(request({}))

    expect(response.result.ok && response.result.value.hasDocument).toBe(true)
  })
})

describe('skills over the layered host registry', () => {
  it('passes the live agent as the view scope to the host registry', async () => {
    const { api, ctx } = await harness(['standard'])
    const seen: unknown[] = []
    ctx.provide('skills', {
      list: (options: { scope?: unknown }) => {
        seen.push(options.scope)
        return Promise.resolve([])
      },
    } as never)
    await createSession(api, { sessionId: SessionId('h1'), agentPreset: 'standard' })

    const response = await api.skills.list(request({ sessionId: SessionId('h1') }))

    expect(response.result).toMatchObject({ ok: true, value: { skills: [] } })
    expect(seen).toEqual([ctx.agents.get(SessionId('h1'))])
  })

  it('resolves a cold session to its recorded preset standing key', async () => {
    const { api, ctx } = await harness(['standard', 'minimal'])
    const seen: unknown[] = []
    ctx.provide('skills', {
      list: (options: { scope?: unknown }) => {
        seen.push(options.scope)
        return Promise.resolve([])
      },
    } as never)
    ctx.sessions.create(SessionId('h2'), { meta: { cwd: '/workspace/cold', agentPreset: 'minimal' } })

    const response = await api.skills.list(request({ sessionId: SessionId('h2') }))

    expect(response.result).toMatchObject({ ok: true, value: { skills: [] } })
    expect(seen).toEqual([standingKeys.get('minimal')])
  })

  it('serves the global view when the roster no longer supplies the recorded preset', async () => {
    const { api, ctx } = await harness(['standard'])
    const seen: unknown[] = []
    ctx.provide('skills', {
      list: (options: { scope?: unknown }) => {
        seen.push(options.scope)
        return Promise.resolve([])
      },
    } as never)
    ctx.sessions.create(SessionId('h3'), { meta: { cwd: '/workspace/cold', agentPreset: 'gone' } })

    const response = await api.skills.list(request({ sessionId: SessionId('h3') }))

    expect(response.result).toMatchObject({ ok: true, value: { skills: [] } })
    expect(seen).toEqual([undefined])
  })
})
