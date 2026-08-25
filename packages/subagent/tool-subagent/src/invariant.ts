/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-subagent`.
 * @module @deepseek-ai/dsh-tool-subagent/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { hasSubagentModelSelection } from './model-selection-state.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-subagent'

/** Cordis companion plugin name. */
export const name = 'tool-subagent-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Assert that a durable opt-in is represented by both model-facing definitions. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (hasSubagentModelSelection(agent.session)) {
      const schemas = ctx.tools.schemas(agent)
      const selectable = schemas.some((schema) => {
        const properties = (schema.parameters as { properties?: Record<string, unknown> }).properties
        return properties?.['provider'] !== undefined
          && properties['model'] !== undefined
          && properties['reasoning_effort'] !== undefined
      })
      if (!selectable || !schemas.some(schema => schema.name === 'list_subagent_models')) {
        fail('a subagent/model-selection-enabled session must expose route fields and list_subagent_models')
      }
    }
    return next()
  }, { global: true })
}, { inject: ['tools'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
