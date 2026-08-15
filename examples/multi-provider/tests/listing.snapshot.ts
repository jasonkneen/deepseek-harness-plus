/**
 * Keyless snapshot of the demo bin's `providers` listing: boot the real leaf
 * through the demo bin under snapshot replay and pin the exact stdout. The
 * listing never dials a provider endpoint, so recording needs no API key.
 * Re-record with `DSH_SNAPSHOT=refresh` (pnpm run test:snapshot:record).
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const binScript = fileURLToPath(new URL('../../../packages/examples/multi-provider-demo/src/bin.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const fixturePath = fileURLToPath(new URL('./snapshots/providers-listing.txt', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

describe('multi-provider demo bin providers listing', () => {
  it('prints the registered routes and catalogs deterministically', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'multi-provider demo listing',
      tempDirPrefix: 'dsh-multi-provider-listing-',
      binScript,
      configPath,
      binArgs: ['--config', configPath, 'providers'],
      tsconfigPath: repoTsconfig,
      env: { DSH_SNAPSHOT: 'replay' },
    })

    expect(stderr).toBe('')
    if (refreshing) {
      await writeFile(fixturePath, stdout)
    }
    const expected = await readFile(fixturePath, 'utf8')
    expect(stdout).toBe(expected)
  }, 120_000)
})
