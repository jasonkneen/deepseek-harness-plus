import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsDescriptor, SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { TypertRemoteFailure, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import SettingsController from '../src/index.ts'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'

const NS = settingsNamespace('ui-test')

const Profile = z.object({
  preference: z.union(['light', 'dark']).default('light'),
  apiKey: z.string().role('secret'),
})

/** A provider that reports a local document, for the `hasDocument` fact. */
class DocumentSettings extends MemorySettings {
  override get documentPath(): string | undefined {
    return '/deployment/settings.yaml'
  }
}

/** A provider whose read forgets the namespace its write just committed. */
class VanishingSettings extends MemorySettings {
  override describe(): SettingsDescriptor[] {
    return []
  }
}

/**
 * A provider whose descriptor omits the secret-slot list. `secrets` is optional
 * on the descriptor, so a foreign provider may leave it out even under
 * `redactSecrets`, and the view still has to declare an empty list.
 */
class SlotlessSettings extends MemorySettings {
  override describe(): SettingsDescriptor[] {
    return [{
      ns: NS,
      schema: Profile.toJSON(),
      value: { preference: 'light' },
      applies: 'live',
      revision: 0,
    } as unknown as SettingsDescriptor]
  }
}

/** A provider that refuses every write the way a read-only backing store would. */
class RefusingSettings extends MemorySettings {
  override mutate(ns: SettingsNamespace): Promise<void> {
    return Promise.reject(new Error(`settings "${ns}" is read-only in this deployment`))
  }
}

/** A provider that refuses with a bare string, the way some storage clients do. */
class LiteralRefusingSettings extends MemorySettings {
  override async mutate(): Promise<void> {
    throw 'the document is locked'
  }
}

async function boot(
  provider: typeof MemorySettings = MemorySettings,
  options: { doc?: Record<string, unknown>; base?: { preference: 'light' | 'dark' } } = {},
): Promise<{ controller: SettingsController; ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(provider, options.doc === undefined ? {} : { doc: options.doc })
  ctx.settings.register(NS, Profile, options.base === undefined ? {} : { base: options.base })
  await ctx.plugin(SettingsController)
  return { controller: ctx.settingsController, ctx }
}

describe('the settings Remote namespace a configuration page calls', () => {
  it('publishes the settings namespace from its own service key', async () => {
    const { controller } = await boot()
    expect(controller.typertRemote.serviceKey).toBe('settingsController')
    expect(controller.typertRemote.namespace).toBe('settings')
    expect(remoteMethods(controller)).toEqual([
      { method: 'describe', invocation: { kind: 'direct' } },
      { method: 'update', invocation: { kind: 'direct' } },
      { method: 'replace', invocation: { kind: 'direct' } },
      { method: 'mutate', invocation: { kind: 'direct' } },
    ])
  })

  it('reports the actionable configuration error while no settings provider is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SettingsController)
    const calls: Array<() => unknown> = [
      () => ctx.settingsController.describe(),
      () => ctx.settingsController.update('ui-test', {}, undefined),
      () => ctx.settingsController.replace('ui-test', {}, undefined),
      () => ctx.settingsController.mutate('ui-test', [], undefined),
    ]
    for (const call of calls) {
      const failure = await Promise.resolve().then(call).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(TypertRemoteFailure)
      expect((failure as TypertRemoteFailure).failure).toEqual({
        code: 'internal',
        message: 'settings service is absent: this deployment does not mount a settings provider (e.g. @deepseek-ai/dsh-settings-file) in its composition',
        details: {},
      })
    }
  })

  it('mounts the credentials namespace beside its own', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    ctx.settings.register(NS, Profile)
    const fiber = ctx.plugin(SettingsController)
    await fiber.await()
    expect(ctx.get('credentialsController')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('settingsController')).toBeUndefined()
    expect(ctx.get('credentialsController')).toBeUndefined()
  })

  it('describes every namespace redacted, with the deployment facts around them', async () => {
    const { controller } = await boot(DocumentSettings, { doc: { 'ui-test': { apiKey: 'sk-stored' } } })
    const value = controller.describe()
    expect(value).toMatchObject({ writable: true, hasDocument: true })
    const [view] = value.namespaces
    expect(view?.ns).toBe('ui-test')
    // The secret never rides; its slot reports only that one is stored.
    expect(JSON.stringify(value)).not.toContain('sk-stored')
    expect(view?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    // Redaction removes the field rather than replacing it, so the layer that
    // stored a secret comes back empty instead of carrying a placeholder.
    expect(view?.user).toEqual({})
  })

  it('reports a read-only provider and omits the layers it has none of', async () => {
    const { controller } = await boot(class extends MemorySettings {
      override get writable(): boolean {
        return false
      }
    })
    const value = controller.describe()
    expect(value).toMatchObject({ writable: false, hasDocument: false })
    const [view] = value.namespaces
    // No composition base was declared and no user section is stored, so
    // neither optional layer appears at all.
    expect(view && 'base' in view).toBe(false)
    expect(view && 'user' in view).toBe(false)
  })

  it('declares an empty slot list when the provider names no secrets', async () => {
    const { controller } = await boot(SlotlessSettings)
    const [view] = controller.describe().namespaces
    expect(view?.secrets).toEqual([])
  })

  it('carries the composition base layer when the registrant declared one', async () => {
    const { controller } = await boot(MemorySettings, { base: { preference: 'dark' } })
    const [view] = controller.describe().namespaces
    expect(view?.base).toEqual({ preference: 'dark' })
  })

  it('applies path-addressed edits and answers with the namespace it just wrote', async () => {
    const { controller } = await boot()
    const view = await controller.mutate('ui-test', [{ op: 'set', path: ['preference'], value: 'dark' }], undefined)
    expect(view).toMatchObject({ ns: 'ui-test', user: { preference: 'dark' } })
    expect(view.revision).toBeGreaterThan(0)
  })

  it('supports merge updates and wholesale replacement on the Remote namespace', async () => {
    const { controller } = await boot(MemorySettings, {
      doc: { 'ui-test': { preference: 'dark', apiKey: 'sk-stored' } },
    })
    const updated = await controller.update('ui-test', { preference: 'light' }, undefined)
    expect(updated.user).toEqual({ preference: 'light' })
    expect(updated.secrets).toEqual([{ path: ['apiKey'], set: true }])

    const replaced = await controller.replace('ui-test', {}, updated.revision)
    expect(replaced.value).toEqual({ preference: 'light' })
    expect(replaced.user).toEqual({})
    expect(replaced.secrets).toEqual([{ path: ['apiKey'], set: false }])
  })

  it('refuses a stale write as settings-conflict carrying both revisions', async () => {
    const { controller } = await boot()
    const held = controller.describe().namespaces[0]!.revision
    await controller.mutate('ui-test', [{ op: 'set', path: ['preference'], value: 'dark' }], held)
    const failure = await controller
      .mutate('ui-test', [{ op: 'set', path: ['preference'], value: 'light' }], held)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TypertRemoteFailure)
    const { code, details } = (failure as TypertRemoteFailure).failure
    expect(code).toBe('settings-conflict')
    expect(details).toMatchObject({ ns: 'ui-test', expected: held })
  })

  it('answers a malformed namespace exactly as an unregistered one', async () => {
    const { controller } = await boot()
    for (const ns of ['Not A Namespace', 'unregistered']) {
      const failure = await controller.mutate(ns, [{ op: 'unset', path: ['preference'] }], undefined)
        .catch((error: unknown) => error)
      expect((failure as TypertRemoteFailure).failure).toMatchObject({
        code: 'settings-rejected',
        details: { ns },
      })
    }
  })

  it('reports an empty namespace as bad-request', async () => {
    const { controller } = await boot()
    for (const call of [
      () => controller.update('', {}, undefined),
      () => controller.replace('', {}, undefined),
      () => controller.mutate('', [], undefined),
    ]) {
      const failure = await call().catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(TypertRemoteFailure)
      expect((failure as TypertRemoteFailure).failure).toMatchObject({ code: 'bad-request' })
    }
  })

  it('reports a refused write as settings-rejected carrying the seam message', async () => {
    const { controller } = await boot(RefusingSettings)
    const failure = await controller.mutate('ui-test', [{ op: 'unset', path: ['preference'] }], undefined)
      .catch((error: unknown) => error)
    const { code, message } = (failure as TypertRemoteFailure).failure
    expect(code).toBe('settings-rejected')
    expect(message).toContain('read-only in this deployment')
  })

  it('stringifies a refusal that is not an Error', async () => {
    const { controller } = await boot(LiteralRefusingSettings)
    const failure = await controller.mutate('ui-test', [{ op: 'unset', path: ['preference'] }], undefined)
      .catch((error: unknown) => error)
    expect((failure as TypertRemoteFailure).failure.message).toBe('the document is locked')
  })

  it('reports a namespace disposed between the write and its read-back', async () => {
    const { controller } = await boot(VanishingSettings)
    const failure = await controller.mutate('ui-test', [{ op: 'set', path: ['preference'], value: 'dark' }], undefined)
      .catch((error: unknown) => error)
    const { code, message } = (failure as TypertRemoteFailure).failure
    expect(code).toBe('internal')
    expect(message).toContain('was disposed after the mutate')
  })
})
