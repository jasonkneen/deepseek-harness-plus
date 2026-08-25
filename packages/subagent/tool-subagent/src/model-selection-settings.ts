/** Host-owned opt-in setting for model-selectable subagent delegation. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User preference sampled when a new Agent receives its delegation tools. */
    subagentModelSelection: SubagentModelSelectionConfig
  }
}

/** User-settings section for model-selectable subagent delegation. */
export const SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE = settingsNamespace('subagent-model-selection')

/** Stored user preference; the shipped composition defaults it off. */
export interface SubagentModelSelectionSettings {
  /** Whether new Agents may expose child LLM route selection to the model. */
  enabled: boolean
}

/** Schema served to settings clients for the opt-in preference. */
export const SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA: z<SubagentModelSelectionSettings> = z.object({
  enabled: z.boolean().default(false),
})

/** Optional deployment base for the preference. */
export interface Config {
  /** Initial value inherited when the user document does not override it. */
  enabled?: boolean
}

/** Singleton settings owner read by delegation tools when an Agent is published. */
export class SubagentModelSelectionConfig extends Service {
  static Config: z<Config> = z.object({
    enabled: z.boolean().default(false),
  })

  private source: () => SubagentModelSelectionSettings

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'subagentModelSelection')
    const entry: SubagentModelSelectionSettings = { enabled: config.enabled === true }
    this.source = () => entry
    installSettingsSection(
      ctx,
      SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE,
      SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA,
      entry,
      {
        setSource: (source) => { this.source = source },
        // Consumers sample at Agent publication, so a settings update never
        // rebuilds the tool definitions of an Agent that is already running.
        onChange: () => {},
      },
    )
  }

  /**
   * Read the preference for the next eligible Agent publication.
   * @returns whether that Agent should receive model-selectable delegation.
   */
  currentEnabled(): boolean {
    return this.source().enabled
  }
}

export const name = 'subagent-model-selection-settings'
export default SubagentModelSelectionConfig
