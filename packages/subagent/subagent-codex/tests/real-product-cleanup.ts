import { rm } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { ResponsesFixture } from './responses-fixture.ts'

interface RealProductResources {
  contexts: { fiber: Pick<Context['fiber'], 'dispose'> }[]
  fixtures: Pick<ResponsesFixture, 'close'>[]
  roots: string[]
}

/**
 * Dispose Codex test contexts and HTTP fixtures before removing their files.
 * Captures all registries before awaiting, so later tests retain their resources.
 * @param resources - mutable registries of resources owned by the test.
 */
export async function cleanupRealProduct(resources: RealProductResources): Promise<void> {
  const contexts = resources.contexts.splice(0)
  const fixtures = resources.fixtures.splice(0)
  const roots = resources.roots.splice(0)
  try {
    await Promise.all(contexts.map(ctx => ctx.fiber.dispose()))
  } catch (cause) {
    throw new Error('Codex test context disposal failed', { cause })
  }
  try {
    await Promise.all(fixtures.map(fixture => fixture.close()))
  } catch (cause) {
    throw new Error('Codex test HTTP fixture closure failed', { cause })
  }
  for (const root of roots) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch (cause) {
      throw new Error(`Codex test temporary root removal failed: ${root}`, { cause })
    }
  }
}
