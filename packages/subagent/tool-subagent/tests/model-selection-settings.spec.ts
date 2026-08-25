/** Default-off settings and per-session model-selection decisions. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { bindScopeParent, createScope, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as tool from '../src/index.ts'
import * as ToolInvariant from '../src/invariant.ts'
import SubagentModelSelectionConfig, {
  SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE,
} from '../src/model-selection-settings.ts'
import { hasSubagentModelSelection } from '../src/model-selection-state.ts'

/** Writable in-memory settings provider for the package integration. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

/** Read whether one Agent's delegation definition contains route fields. */
function selectable(ctx: Context, agent: Awaited<ReturnType<Context['agents']['create']>>['agent']): boolean {
  const schema = ctx.tools.schemas(agent).find(candidate => candidate.name === 'subagent')
  const properties = (schema?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  return properties?.['provider'] !== undefined
    && properties['model'] !== undefined
    && properties['reasoning_effort'] !== undefined
    && ctx.tools.schemas(agent).some(candidate => candidate.name === 'list_subagent_models')
}

/** Mount the real settings, Agent, provider, and tool services. */
async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  await ctx.plugin(SubagentModelSelectionConfig)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  return ctx
}

/** Create one Agent whose setup mounts the settings-controlled tool preset row. */
async function createAgent(ctx: Context, id: string, options: {
  meta?: { parentSession: SessionId; origin: 'subagent' }
  seed?: readonly SessionEvent[]
} = {}) {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    ...options,
    setup: async (agentCtx) => {
      await agentCtx.plugin(tool, {
        provider: 'spawn',
        modelSelectionSettings: true,
        backgroundMode: 'continuable',
      })
    },
  })
  return handle.agent
}

describe('SubagentModelSelectionConfig', () => {
  it('uses the composed default without a settings provider', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentModelSelectionConfig, { enabled: true })

    expect(ctx.subagentModelSelection.currentEnabled()).toBe(true)
    await ctx.fiber.dispose()
  })

  it('defaults off and follows the validated user layer', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(SubagentModelSelectionConfig)

    expect(ctx.subagentModelSelection.currentEnabled()).toBe(false)
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, { enabled: true })
    expect(ctx.subagentModelSelection.currentEnabled()).toBe(true)
    await ctx.fiber.dispose()
  })

  it('samples each new root session without changing existing Agents', async () => {
    const ctx = await boot()
    const disabled = await createAgent(ctx, 'disabled')
    expect(selectable(ctx, disabled)).toBe(false)
    expect(hasSubagentModelSelection(disabled.session)).toBe(false)

    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, { enabled: true })
    const enabled = await createAgent(ctx, 'enabled')
    expect(hasSubagentModelSelection(enabled.session)).toBe(true)
    expect(selectable(ctx, enabled)).toBe(true)
    expect(selectable(ctx, disabled)).toBe(false)

    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, { enabled: false })
    const disabledAgain = await createAgent(ctx, 'disabled-again')
    expect(selectable(ctx, disabledAgain)).toBe(false)
    expect(selectable(ctx, enabled)).toBe(true)
    await ctx.fiber.dispose()
  })

  it('installs per-Agent definitions for a shared preset scope', async () => {
    const ctx = await boot()
    const preset = createScope(ctx, { preset: 'standard' })
    const other = createScope(ctx, { preset: 'minimal' })
    await preset.ctx.plugin(tool, {
      provider: 'spawn',
      modelSelectionSettings: true,
      backgroundMode: 'continuable',
    })

    let enabledBinding: ReturnType<typeof bindScopeParent> | undefined
    const createComposed = async (id: string) => ctx.agents.create({
      sessionId: SessionId(id),
      setup: (agentCtx) => {
        const binding = bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!)
        if (id === 'preset-enabled') enabledBinding = binding
      },
    })

    const disabled = await createComposed('preset-disabled')
    expect(selectable(ctx, disabled.agent)).toBe(false)
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, { enabled: true })
    const enabled = await createComposed('preset-enabled')
    expect(selectable(ctx, enabled.agent)).toBe(true)
    expect(selectable(ctx, disabled.agent)).toBe(false)

    enabledBinding!.rebind(scopeOf(other.ctx)!)
    ctx.emit(scopeTarget({}, scopeOf(preset.ctx)), 'tools/change')
    await vi.waitFor(() => { expect(selectable(ctx, enabled.agent)).toBe(false) })
    enabledBinding!.rebind(scopeOf(preset.ctx)!)
    ctx.emit(scopeTarget({}, scopeOf(preset.ctx)), 'tools/change')
    await vi.waitFor(() => { expect(selectable(ctx, enabled.agent)).toBe(true) })

    await enabled.dispose()
    ctx.emit(scopeTarget({}, scopeOf(preset.ctx)), 'tools/change')
    await disabled.dispose()
    await ctx.fiber.dispose()
  })

  it('inherits the parent decision and preserves seeded decisions across composition', async () => {
    const ctx = await boot()
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, { enabled: true })
    const parent = await createAgent(ctx, 'parent')
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, { enabled: false })
    const child = await createAgent(ctx, 'child', {
      meta: { parentSession: parent.id, origin: 'subagent' },
    })
    expect(selectable(ctx, child)).toBe(true)
    expect(hasSubagentModelSelection(child.session)).toBe(true)

    const enabledSeed = Session.create(SessionId('enabled-seed'))
    enabledSeed.append('subagent/model-selection-enabled', {})
    const resumedEnabled = await createAgent(ctx, 'resumed-enabled', { seed: enabledSeed.events })
    expect(selectable(ctx, resumedEnabled)).toBe(true)

    const oldSeed = Session.create(SessionId('old-seed'), [])
    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, { enabled: true })
    const resumedDisabled = await createAgent(ctx, 'resumed-disabled', { seed: oldSeed.events })
    expect(selectable(ctx, resumedDisabled)).toBe(false)
    expect(hasSubagentModelSelection(resumedDisabled.session)).toBe(false)
    await ctx.fiber.dispose()
  })

  it('rejects ambiguous static and settings-controlled configuration', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SubagentRuntime)
    expect(() => {
      tool.apply(ctx, {
        provider: 'missing',
        enableModelSelection: true,
        modelSelectionSettings: true,
      })
    }).toThrow('mutually exclusive')
    await ctx.fiber.dispose()
  })

  it('requires both the Host setting owner and a composition scope', async () => {
    const withoutSettings = new Context()
    await mountAgentLoopTestDependencies(withoutSettings)
    await withoutSettings.plugin(SubagentRuntime)
    expect(() => {
      tool.apply(withoutSettings, {
        provider: 'missing',
        modelSelectionSettings: true,
        maxDepth: 'provider-managed',
      })
    }).toThrow('requires @deepseek-ai/dsh-tool-subagent/model-selection-settings')
    await withoutSettings.fiber.dispose()

    const withoutAgent = await boot()
    expect(() => {
      tool.apply(withoutAgent, {
        provider: 'spawn',
        modelSelectionSettings: true,
        backgroundMode: 'continuable',
      })
    }).toThrow('requires an Agent or preset scope')
    await withoutAgent.fiber.dispose()
  })

  it('checks the durable decision against the published tool definitions', async () => {
    const ctx = await boot()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(ToolInvariant)
    const disabled = await createAgent(ctx, 'invariant-disabled')
    const next = () => Promise.resolve({ kind: 'enter' as const, messages: [] })
    const payload = {
      agent: disabled,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', payload, next)).resolves.toEqual({
      kind: 'enter', messages: [],
    })

    disabled.session.append('subagent/model-selection-enabled', {})
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', payload, next))
      .rejects.toThrow('must expose route fields and list_subagent_models')

    await ctx.settings.update(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, { enabled: true })
    const enabled = await createAgent(ctx, 'invariant-enabled')
    await expect(ctx.waterfall(ctx as never, 'agent/pre-step', { ...payload, agent: enabled }, next))
      .resolves.toEqual({ kind: 'enter', messages: [] })
    await ctx.fiber.dispose()
  })
})
