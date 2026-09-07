import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { cleanupRealProduct } from './real-product-cleanup.ts'

it.each(['context', 'HTTP fixture'] as const)('attributes %s cleanup failures without losing the cause', async (stage) => {
  const cause = new Error('fixture failure')
  const fail = (): Promise<void> => Promise.reject(cause)
  await expect(cleanupRealProduct({
    contexts: stage === 'context' ? [{ fiber: { dispose: fail } }] : [],
    fixtures: stage === 'HTTP fixture' ? [{ close: fail }] : [],
    roots: [],
  })).rejects.toMatchObject({
    message: stage === 'context'
      ? 'Codex test context disposal failed'
      : 'Codex test HTTP fixture closure failed',
    cause,
  })
})

it('attributes root removal failures to the owned path', async () => {
  const root = 'invalid\0root'
  await expect(cleanupRealProduct({ contexts: [], fixtures: [], roots: [root] }))
    .rejects.toMatchObject({
      message: `Codex test temporary root removal failed: ${root}`,
      cause: { code: 'ERR_INVALID_ARG_VALUE' },
    })
})

it('keeps resources registered during pending cleanup for their own cleanup', async () => {
  const oldRoot = mkdtempSync(join(tmpdir(), 'dsh-codex-cleanup-old-'))
  const nextRoot = mkdtempSync(join(tmpdir(), 'dsh-codex-cleanup-next-'))
  const releaseContext = Promise.withResolvers<undefined>()
  const oldContext = { fiber: { dispose: vi.fn(() => releaseContext.promise) } }
  const nextContext = { fiber: { dispose: vi.fn(async () => {}) } }
  const oldFixture = { close: vi.fn(async () => {
    expect(existsSync(oldRoot)).toBe(true)
  }) }
  const nextFixture = { close: vi.fn(async () => {}) }
  const resources: Parameters<typeof cleanupRealProduct>[0] = {
    contexts: [oldContext], fixtures: [oldFixture], roots: [oldRoot],
  }
  const cleanup = cleanupRealProduct(resources)
  try {
    expect(oldContext.fiber.dispose).toHaveBeenCalledOnce()
    expect(oldFixture.close).not.toHaveBeenCalled()
    resources.contexts.push(nextContext)
    resources.fixtures.push(nextFixture)
    resources.roots.push(nextRoot)
    releaseContext.resolve(undefined)
    await cleanup

    expect(oldFixture.close).toHaveBeenCalledOnce()
    expect(existsSync(oldRoot)).toBe(false)
    expect(nextContext.fiber.dispose).not.toHaveBeenCalled()
    expect(nextFixture.close).not.toHaveBeenCalled()
    expect(existsSync(nextRoot)).toBe(true)
    expect(resources).toEqual({ contexts: [nextContext], fixtures: [nextFixture], roots: [nextRoot] })

    await cleanupRealProduct(resources)
    expect(nextContext.fiber.dispose).toHaveBeenCalledOnce()
    expect(nextFixture.close).toHaveBeenCalledOnce()
    expect(existsSync(nextRoot)).toBe(false)
    expect(resources).toEqual({ contexts: [], fixtures: [], roots: [] })
  } finally {
    releaseContext.resolve(undefined)
    await cleanup
    rmSync(oldRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    rmSync(nextRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
