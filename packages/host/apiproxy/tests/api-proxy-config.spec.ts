/**
 * Settings and llm RPC domains and their owner events over createApiProxy:
 * layered redacted describe, write-path rejection mapping, the
 * directory/live-route merge, and the settings and model invalidation frames.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SettingsProvider, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { RpcRequest, RpcResponse } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-agent-default-model'
import { createApiProxy } from '../src/api-proxy.ts'

const DEFAULTS = { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`req-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function expectErr<T>(response: RpcResponse<T>): { code: string; message: string; details: unknown } {
  expect(response.result.ok).toBe(false)
  if (response.result.ok) throw new Error('unreachable')
  return response.result.error
}

/** In-memory settings provider: the Service Definition base class owns all tested behavior. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options?: {
    doc?: Record<string, unknown>
    readOnly?: boolean
    documentPath?: string
    preparedPath?: string
  }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
    this.readOnly = options?.readOnly ?? false
    this.path = options?.documentPath
    this.preparedPath = options?.preparedPath
  }

  private readonly readOnly: boolean
  private readonly path: string | undefined
  private readonly preparedPath: string | undefined

  get writable(): boolean {
    return !this.readOnly
  }

  override get documentPath(): string | undefined {
    return this.path
  }

  override prepareDocument(): Promise<string | undefined> {
    return Promise.resolve(this.preparedPath ?? this.documentPath)
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

/** In-memory credential provider with an env-shadow double for the rejection path. */
class MemoryCredentials extends CredentialProvider {
  private readonly values = new Map<string, string>()

  constructor(ctx: ConstructorParameters<typeof CredentialProvider>[0], options?: { shadowed?: string[] }) {
    super(ctx)
    this.shadowed = new Set(options?.shadowed ?? [])
  }

  private readonly shadowed: Set<string>

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (this.shadowed.has(ref)) return Promise.resolve({ value: 'from-env', source: 'env' })
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'file' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (this.shadowed.has(ref)) return Promise.resolve({ configured: true, source: 'env', writable: false })
    const configured = this.values.has(ref)
    return Promise.resolve({ configured, ...configured ? { source: 'file' } : {}, writable: true })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    if (this.shadowed.has(ref)) {
      return Promise.reject(new Error(`credentials: ${ref} is shadowed by the read-only environment`))
    }
    this.values.set(ref, value)
    this.ctx.emit('credentials/reference-updated', ref)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    if (this.shadowed.has(ref)) {
      return Promise.reject(new Error(`credentials: ${ref} is shadowed by the read-only environment`))
    }
    this.values.delete(ref)
    this.ctx.emit('credentials/reference-updated', ref)
    return Promise.resolve()
  }

  // The record half has no wire face on this proxy, so the double answers the
  // empty store rather than modelling storage the tests never exercise.
  readRecord(): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  describeRecord(): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([])
  }

  modifyRecord(
    _key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return mutate(undefined)
  }

  deleteRecord(): Promise<void> {
    return Promise.resolve()
  }
}

/** Catalog-serving adapter stub for the llm.models path. */
class CatalogAdapter extends LlmAdapter {
  constructor(private readonly name: string, private readonly models: readonly string[]) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.name }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models.map(id => ({ provider, id, name: id })))
  }


  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('not exercised')
  }
}

class BrokenCatalogAdapter extends CatalogAdapter {
  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.reject(new Error('catalog backend down'))
  }
}

const NS = settingsNamespace('llm-deepseek')

const AdapterConfig = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().default('DEEPSEEK_API_KEY'),
  baseURL: z.string(),
})

async function harness(options?: {
  settings?: false | {
    doc?: Record<string, unknown>
    readOnly?: boolean
    documentPath?: string
    preparedPath?: string
  }
  credentials?: false | { shadowed?: string[] }
  /** Skip the directory registration to exercise a namespace the proxy does not expose. */
  configurableProviders?: false
}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  if (options?.settings !== false) await ctx.plugin(MemorySettings, options?.settings)
  if (options?.credentials !== false) await ctx.plugin(MemoryCredentials, options?.credentials)
  // Model-provider namespaces plus the explicit Web preference and product
  // onboarding allowlists are the proxy's complete settings surface.
  if (options?.configurableProviders !== false) {
    ctx.llm.registerConfigurableProviders([
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
    ])
  }
  return ctx
}

/** Observe settings commits while one API operation runs. */
async function captureSettingsUpdates(
  ctx: Context,
  run: () => Promise<void>,
): Promise<Array<readonly [SettingsNamespace, number]>> {
  const updates: Array<readonly [SettingsNamespace, number]> = []
  const dispose = ctx.on('settings/document-updated', (namespace, revision) => {
    updates.push([namespace, revision])
  })
  try {
    await run()
    return updates
  } finally {
    dispose()
  }
}

/** Count model-adapter topology commits while one API operation runs. */
async function countAdapterUpdates(ctx: Context, run: () => Promise<void>): Promise<number> {
  let updates = 0
  const dispose = ctx.on('llm/adapters-updated', () => { updates += 1 })
  try {
    await run()
    return updates
  } finally {
    dispose()
  }
}

/** Expected settings event tuple with its owner-assigned revision. */
function expectedSettingsUpdate(ns: string): readonly unknown[] {
  return [ns, expect.any(Number)]
}

describe('settings domain', () => {
  it('reports an actionable error when no settings provider is mounted', async () => {
    const ctx = await harness({ settings: false })
    const api = createApiProxy(ctx, DEFAULTS)
    const error = expectErr(await api.settings.openDocument(request({}), new AbortController().signal))
    expect(error.code).toBe('internal')
    expect(error.message).toContain('dsh-settings-file')
  })


  it('opens the provider-resolved document without accepting a browser path', async () => {
    const ctx = await harness({ settings: {
      documentPath: '/tmp/described-settings.yaml',
      preparedPath: '/tmp/custom-settings.yaml',
    } })
    const opened: string[] = []
    const api = createApiProxy(ctx, {
      ...DEFAULTS,
      openTextFile: (path) => {
        opened.push(path)
        return Promise.resolve()
      },
    })

    expect(expectOk(await api.settings.openDocument(request({}), new AbortController().signal)))
      .toEqual({ opened: true })
    expect(opened).toEqual(['/tmp/custom-settings.yaml'])
  })

  it('refuses to open settings when the provider has no local document', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    expect(ctx.settings.documentPath).toBeUndefined()
    const error = expectErr(await api.settings.openDocument(request({}), new AbortController().signal))
    expect(error.code).toBe('internal')
    expect(error.message).toContain('no local document')
  })

  it('does not prepare or open a settings document after cancellation', async () => {
    const ctx = await harness({ settings: { documentPath: '/tmp/settings.yaml' } })
    const opened: string[] = []
    const api = createApiProxy(ctx, {
      ...DEFAULTS,
      openTextFile: (path) => {
        opened.push(path)
        return Promise.resolve()
      },
    })
    const prepare = vi.spyOn(ctx.settings, 'prepareDocument')
    const cancelled = new AbortController()
    cancelled.abort()
    expect(expectErr(await api.settings.openDocument(request({}), cancelled.signal)).code)
      .toBe('cancelled')
    expect(prepare).not.toHaveBeenCalled()

    const pending = Promise.withResolvers<string | undefined>()
    prepare.mockReturnValueOnce(pending.promise)
    const duringPrepare = new AbortController()
    const opening = api.settings.openDocument(request({}), duringPrepare.signal)
    await vi.waitFor(() => { expect(prepare).toHaveBeenCalledOnce() })
    duringPrepare.abort()
    pending.resolve('/tmp/settings.yaml')
    expect(expectErr(await opening).code).toBe('cancelled')
    expect(opened).toEqual([])
  })





  it('forwards a provider settings change for model-catalog consumers', async () => {
    // Editing `models` changes no route, so llm/adapters-updated never fires
    // and an open model picker would keep serving the stale catalog. Storing
    // an override equal to the resolved value emits nothing on
    // settings/updated, so another tab would never learn the field became
    // overridden.
    const ctx = await harness()
    ctx.settings.register(NS, AdapterConfig, { base: { baseURL: 'https://base' } })
    const updates = await captureSettingsUpdates(ctx, async () => {
      await ctx.settings.update(settingsNamespace('llm-deepseek'), { baseURL: 'https://base' })
    })
    expect(updates).toEqual([expectedSettingsUpdate('llm-deepseek')])
    // The resolved value never moved: base already said https://base.
    expect(ctx.settings.describe().find(view => String(view.ns) === 'llm-deepseek')?.value)
      .toEqual({ apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://base' })
  })

  it('broadcasts a permission change without invalidating the model catalog', async () => {
    const ctx = await harness()
    const permission = ctx.settings.register(settingsNamespace('permission'), z.object({
      defaultPreset: z.union(['read-only', 'workspace-write']).required(),
    }), {
      base: { defaultPreset: 'read-only' },
    })
    const updates = await captureSettingsUpdates(ctx, async () => {
      await permission.update({ defaultPreset: 'workspace-write' })
    })
    expect(updates).toEqual([expectedSettingsUpdate('permission')])
  })

  it('forwards an Agent-default settings change for model-catalog consumers', async () => {
    const ctx = await harness()
    const defaultModel = ctx.settings.register(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, z.object({
      provider: z.string().required(),
      model: z.string().required(),
    }), { base: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
    // The shared section names the selection every blank session resolves to,
    // so an externally edited default — another tab, a
    // hand-edited settings.yaml — has to reach an open selector as well.
    const updates = await captureSettingsUpdates(ctx, async () => {
      await defaultModel.replace({ provider: 'deepseek-official', model: 'deepseek-reasoner' })
    })
    expect(updates).toEqual([expectedSettingsUpdate('agent-default-model')])
  })






})

describe('llm domain', () => {
  it('merges the configurable directory with live routes and appends undeclared ones', async () => {
    const ctx = await harness({ configurableProviders: false })
    ctx.llm.registerConfigurableProviders([
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
      { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    ])
    ctx.llm.registerAdapter(['deepseek-official'], new CatalogAdapter('DeepSeek', ['deepseek-v4-flash']))
    ctx.llm.registerAdapter(['undeclared'], new CatalogAdapter('Undeclared', ['u-1']))
    // Only one namespace can answer an interrogation, so the flag follows the
    // entry's namespace rather than being assumed for every row.
    ctx.llm.registerModelDiscovery('llm-pi-ai', () => Promise.resolve([]))
    const api = createApiProxy(ctx, DEFAULTS)
    const value = expectOk(await api.llm.providers(request({})))
    expect(value.providers).toEqual([
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
      { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: false },
      // An undeclared live route has no settings address, so nothing can be
      // interrogated on its behalf either.
      { provider: 'undeclared', displayName: 'Undeclared', settingsNs: '', settingsPath: [], active: true },
    ])
  })

  it('serves the host-scoped catalog with per-provider failures contained', async () => {
    const ctx = await harness()
    ctx.llm.registerAdapter(['deepseek-official'], new CatalogAdapter('DeepSeek', ['deepseek-v4-flash', 'deepseek-v4-pro']))
    ctx.llm.registerAdapter(['broken'], new BrokenCatalogAdapter('Broken', []))
    const api = createApiProxy(ctx, DEFAULTS)
    const value = expectOk(await api.llm.models(request({})))
    expect(value.default).toEqual({ provider: 'p', model: 'm' })
    expect(value.routableProviders).toEqual(['deepseek-official', 'broken'])
    expect(value.groups).toEqual([{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
        { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' },
      ],
    }])
    expect(value.failures).toEqual([{ id: 'broken', name: 'Broken', message: 'catalog backend down' }])
  })

  it('forwards llm/adapters-updated at every topology commit point', async () => {
    const ctx = await harness()
    const updates = await countAdapterUpdates(ctx, async () => {
      const dispose = ctx.llm.registerAdapter(['deepseek-official'], new CatalogAdapter('DeepSeek', []))
      dispose()
      return Promise.resolve()
    })
    expect(updates).toBe(2)
  })
})

describe('llm.discoverModels', () => {
  it('carries a draft to its namespace and returns candidates without storing anything', async () => {
    const ctx = await harness()
    const seen: unknown[] = []
    ctx.llm.registerModelDiscovery('llm-pi-ai', (probe) => {
      seen.push({ baseURL: probe.baseURL, api: probe.api, apiKey: probe.apiKey })
      return Promise.resolve([
        { id: 'acme-large', name: 'Acme Large', contextWindow: 65_536, maxTokens: 4096 },
        { id: 'acme-small' },
      ])
    })
    const api = createApiProxy(ctx, DEFAULTS)

    const value = expectOk(await api.llm.discoverModels(request({
      settingsNs: 'llm-pi-ai',
      baseURL: 'https://gateway.acme.example/v1',
      api: 'openai-completions',
      apiKey: 'probe-key',
    })))

    expect(value.models).toEqual([
      { id: 'acme-large', name: 'Acme Large', contextWindow: 65_536, maxTokens: 4096 },
      { id: 'acme-small' },
    ])
    expect(seen).toEqual([{
      baseURL: 'https://gateway.acme.example/v1',
      api: 'openai-completions',
      apiKey: 'probe-key',
    }])
    // Interrogating a draft is a read: no namespace gained a section, and no
    // credential reference was written.
    expect(ctx.settings.describe().map(view => String(view.ns))).not.toContain('llm-pi-ai')
  })

  it('carries the route being edited so an adapter can answer from its own registry', async () => {
    const ctx = await harness()
    let probe: unknown
    ctx.llm.registerModelDiscovery('llm-pi-ai', (request_) => {
      probe = request_
      return Promise.resolve([{ id: 'from-registry', contextWindow: 65_536, maxTokens: 4096 }])
    })
    const api = createApiProxy(ctx, DEFAULTS)

    const value = expectOk(await api.llm.discoverModels(request({
      settingsNs: 'llm-pi-ai',
      provider: 'deepseek',
    })))

    // No endpoint at all: a route the adapter already describes needs none.
    expect(probe).toEqual({ provider: 'deepseek' })
    expect(value.models).toEqual([{ id: 'from-registry', contextWindow: 65_536, maxTokens: 4096 }])
  })

  it('omits a credential and protocol the draft does not name', async () => {
    const ctx = await harness()
    let probe: unknown
    ctx.llm.registerModelDiscovery('llm-pi-ai', (request_) => {
      probe = request_
      return Promise.resolve([])
    })
    const api = createApiProxy(ctx, DEFAULTS)

    expectOk(await api.llm.discoverModels(request({
      settingsNs: 'llm-pi-ai',
      baseURL: 'https://gateway.acme.example/v1',
    })))

    // Absent fields stay absent rather than crossing as explicit undefined:
    // the adapter distinguishes "no protocol named" from "protocol undefined".
    expect(probe).toEqual({ baseURL: 'https://gateway.acme.example/v1' })
  })

  it('reports a failed interrogation as the form\'s next move, naming no credential', async () => {
    const ctx = await harness()
    ctx.llm.registerModelDiscovery('llm-pi-ai', () =>
      Promise.reject(new Error('https://gateway.acme.example/v1/models answered 401; check the API key')))
    const api = createApiProxy(ctx, DEFAULTS)

    const error = expectErr(await api.llm.discoverModels(request({
      settingsNs: 'llm-pi-ai',
      baseURL: 'https://gateway.acme.example/v1',
      apiKey: 'wrong',
    })))

    expect(error.code).toBe('model-discovery-failed')
    expect(error.message).toContain('answered 401; check the API key')
    expect(error.details).toEqual({ settingsNs: 'llm-pi-ai', baseURL: 'https://gateway.acme.example/v1' })
    expect(JSON.stringify(error)).not.toContain('wrong')
  })

  it('reports a namespace no adapter family serves', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)

    const error = expectErr(await api.llm.discoverModels(request({
      settingsNs: 'llm-deepseek',
      baseURL: 'https://api.deepseek.com',
    })))

    expect(error.code).toBe('model-discovery-failed')
    expect(error.message).toContain('no model discovery is registered')
  })
})
