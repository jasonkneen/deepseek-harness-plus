/**
 * LLM-seam provider plugin for the local engine CLIs. Registers the
 * `claude-code` and `codex` provider routes on `ctx.llm`, backed by the
 * matching `ctx.subagents` backends: selecting one of these providers in the
 * web Models picker (or any model selection) routes the session's turns
 * through the local Claude Code / Codex CLI with its native OAuth state — no
 * API key. The adapter answers each turn with the engine's final text; the
 * engines execute their own tools inside their own process.
 *
 * Function plugin with named exports only: the Loader discards a default
 * export's namespace, dropping this plugin's inject metadata
 * (docs/postmortem/0001).
 * @module @deepseek-ai/dsh-llm-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ENGINE_ROUTES, EngineLlmAdapter } from './adapter.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-engine'

/** Services required before the routes can register. */
export const inject = ['llm', 'subagents']

/** Plugin config: the long-lived session switch for both engine routes. */
export interface Config {
  /**
   * Whether turns resume the engine's long-lived session (Claude `resume`,
   * Codex `thread/resume`) instead of starting fresh. Requires the
   * `continuation: true` option on the matching backend rows; engine state
   * then persists under the native CLI config dirs.
   */
  continuation?: boolean
}

/** @inheritdoc */
export const Config: z<Config> = z.object({
  continuation: z.boolean().default(false),
})

/**
 * Register the engine adapter for the `claude-code` and `codex` routes. The
 * registration is a fiber-owned effect: unloading the plugin withdraws the
 * routes.
 * @param ctx - context carrying the LLM runtime and the subagent service.
 * @param _config - empty plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.llm.registerAdapter([...ENGINE_ROUTES], new EngineLlmAdapter(ctx, config.continuation ?? false))
}
