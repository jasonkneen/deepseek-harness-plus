/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-multi-provider-demo`.
 * @module @deepseek-ai/dsh-multi-provider-demo/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-multi-provider-demo'

/** Cordis companion plugin name. */
export const name = 'multi-provider-demo-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

// No runtime invariant: this demo package owns no independent event stream or
// mutable data; the leaf's keyless boot spec and keyed e2e cover its wiring.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
