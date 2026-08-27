/**
 * Host Remote owner for the configuration surfaces over the settings-domain
 * seams. Two namespaces: `settings`, the redacted reads and writes of
 * `ctx.settings`, owned by the class below; and `credentials`, mounted from
 * here as its own plugin.
 *
 * @module @deepseek-ai/dsh-api-settings-controller
 */

import { Context } from '@deepseek-ai/cordis'
import { SettingsConflictError, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsDescriptor, SettingsPathOp, SettingsProvider } from '@deepseek-ai/dsh-settings'
import type {
  SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-settings/types'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { Remote, TypertRemoteFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { CredentialsController } from './credentials.ts'

export { CredentialsController } from './credentials.ts'
export type * from './types.ts'

const settingsNamespaceRequestSchema = z.object({ ns: z.string().min(1) })

/**
 * Project one redacted descriptor onto its wire view, field by field. The
 * Gateway returns a business result without decoding it, so a provider whose
 * descriptor carried extra enumerable properties would otherwise serialize them
 * to the caller.
 * @param descriptor - one descriptor read under `redactSecrets`.
 * @returns the same facts with nothing else attached.
 */
function namespaceView(descriptor: SettingsDescriptor): SettingsNamespaceView {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema as JsonValue,
    value: descriptor.value as JsonValue,
    ...descriptor.base === undefined ? {} : { base: descriptor.base as JsonValue },
    ...descriptor.user === undefined ? {} : { user: descriptor.user as JsonValue },
    applies: descriptor.applies,
    secrets: (descriptor.secrets ?? []).map(secret => ({ path: [...secret.path], set: secret.set })),
    revision: descriptor.revision,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `settings` Remote namespace. */
    settingsController: SettingsController
  }
}

/**
 * Host service backing the generated `ctx.remote.settings` namespace. Every
 * remote read uses `redactSecrets: true`, so a `role('secret')` field cannot
 * ride a response. Writes expose the settings service's merge, replacement,
 * and path-addressed operations, and classify every provider refusal as
 * `settings-conflict` or `settings-rejected` with the service's message.
 */
export class SettingsController extends TypertRemoteService {
  /**
   * Register the settings namespace and mount the credentials namespace beside
   * it. Both namespaces stay registered when a provider is absent so calls can
   * return the configuration API's actionable missing-provider diagnostic.
   * @param ctx - Host context where settings and credential providers may be mounted.
   */
  constructor(ctx: Context) {
    super(ctx, 'settingsController', { namespace: 'settings' })
    ctx.plugin(CredentialsController)
  }

  /**
   * Describe every registered namespace for a configuration page: redacted
   * layered values plus the serialized schema the page renders its form from.
   * @returns provider writability, local-document presence, and one view per namespace.
   * @throws TypertRemoteFailure when no settings provider is mounted.
   */
  @Remote
  describe(): SettingsDescribeValue {
    const settings = this.provider()
    return {
      writable: settings.writable,
      hasDocument: settings.documentPath !== undefined,
      namespaces: settings.describe({ redactSecrets: true }).map(namespaceView),
    }
  }

  /**
   * Merge a patch into one namespace's stored user section.
   * @param ns - namespace key to write.
   * @param patch - fields to merge into the user section.
   * @param expectedRevision - revision the caller read; `undefined` writes unconditionally.
   * @returns the namespace's redacted view after the write.
   * @throws TypertRemoteFailure when the request is invalid, no provider is mounted, or the provider refuses the write.
   */
  @Remote
  update(
    ns: string,
    patch: Record<string, JsonValue>,
    expectedRevision: number | undefined,
  ): Promise<SettingsNamespaceView> {
    return this.write(ns, 'update', patch, expectedRevision)
  }

  /**
   * Replace one namespace's stored user section wholesale.
   * @param ns - namespace key to write.
   * @param section - complete replacement user section.
   * @param expectedRevision - revision the caller read; `undefined` writes unconditionally.
   * @returns the namespace's redacted view after the write.
   * @throws TypertRemoteFailure when the request is invalid, no provider is mounted, or the provider refuses the write.
   */
  @Remote
  replace(
    ns: string,
    section: Record<string, JsonValue>,
    expectedRevision: number | undefined,
  ): Promise<SettingsNamespaceView> {
    return this.write(ns, 'replace', section, expectedRevision)
  }

  /**
   * Apply path-addressed edits to one namespace's user section, resolved against
   * the section as stored rather than against whatever the caller last read,
   * then answer with that namespace's new redacted view.
   * @param ns - namespace key to write.
   * @param ops - the edits to apply, in order.
   * @param expectedRevision - revision the caller read; `undefined` writes unconditionally.
   * @returns the namespace's redacted view after the write.
   * @throws TypertRemoteFailure when the request is invalid, no provider is mounted, or the provider refuses the write.
   */
  @Remote
  async mutate(
    ns: string,
    ops: SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SettingsNamespaceView> {
    return this.write(ns, 'mutate', ops, expectedRevision)
  }

  private async write(
    ns: string,
    mode: 'update' | 'replace' | 'mutate',
    input: Record<string, JsonValue> | SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SettingsNamespaceView> {
    const parsed = settingsNamespaceRequestSchema.safeParse({ ns })
    if (!parsed.success) {
      throw new TypertRemoteFailure({
        code: 'bad-request',
        message: `invalid payload for settings.${mode}`,
        details: { issues: parsed.error.issues },
      })
    }
    const settings = this.provider()
    let branded
    try {
      // A malformed name can address no registration, so it fails exactly as an
      // unregistered one does.
      branded = settingsNamespace(parsed.data.ns)
    } catch (error: unknown) {
      throw rejected(ns, error)
    }
    try {
      if (mode === 'update') await settings.update(branded, input, expectedRevision)
      else if (mode === 'replace') await settings.replace(branded, input, expectedRevision)
      else await settings.mutate(branded, input as SettingsPathOp[], expectedRevision)
    } catch (error: unknown) {
      throw rejected(ns, error)
    }
    const descriptor = settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === branded)
    if (descriptor === undefined) {
      // The write committed but the namespace vanished before this read: only a
      // concurrent registrant disposal can produce it.
      throw new TypertRemoteFailure({
        code: 'internal',
        message: `settings namespace "${ns}" was disposed after the ${mode}`,
        details: {},
      })
    }
    return namespaceView(descriptor)
  }

  /** Resolve the optional provider or report how to supply it. */
  private provider(): SettingsProvider {
    const settings = this.ctx.get('settings')
    if (settings === undefined) {
      throw new TypertRemoteFailure({
        code: 'internal',
        message: 'settings service is absent: this deployment does not mount a settings provider (e.g. @deepseek-ai/dsh-settings-file) in its composition',
        details: {},
      })
    }
    return settings
  }
}

/**
 * Classify one seam refusal. A stale writer is its own outcome, not a malformed
 * request: the client must re-read and re-apply rather than treat the write as
 * invalid.
 * @param ns - the namespace the write addressed.
 * @param error - whatever the seam threw.
 * @returns the failure to raise for that refusal.
 */
function rejected(ns: string, error: unknown): TypertRemoteFailure {
  if (error instanceof SettingsConflictError) {
    return new TypertRemoteFailure({
      code: 'settings-conflict',
      message: error.message,
      details: { ns, expected: error.expected, actual: error.actual },
    })
  }
  return new TypertRemoteFailure({
    code: 'settings-rejected',
    message: error instanceof Error ? error.message : String(error),
    details: { ns },
  })
}

export default SettingsController
