/**
 * The invariant companion is this package's only runtime code; mounting it
 * against the real invariant registry proves the companion conforms to the
 * package-invariant contract and disposes cleanly.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as DemoInvariant from '@deepseek-ai/dsh-multi-provider-demo/invariant'

describe('multi-provider-demo invariant companion', () => {
  it('registers against the invariant service and disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const instance = await ctx.plugin(DemoInvariant)
    expect(typeof instance.dispose).toBe('function')
    await instance.dispose()
    await ctx.fiber.dispose()
  })
})
