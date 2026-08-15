/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-llm-engine`.
 * @module @deepseek-ai/dsh-llm-engine/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-engine'

/** Cordis companion plugin name. */
export const name = 'llm-engine-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

// No runtime invariant: the adapter owns no independent event stream or
// mutable relation of its own; route registration and the stream grammar are
// covered by the adapter spec and the leaf's real-composition suites.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
