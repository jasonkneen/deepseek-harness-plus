import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cleanupRunnerFiles, createRunnerFiles, readRunnerEventsAsync } from '../src/runner-protocol.ts'

const builtEntry = fileURLToPath(new URL(
  './lib/spawn-runner.js',
  import.meta.resolve('@deepseek-ai/dsh-subprocess-local/package.json'),
))
const required = process.env.DSH_REQUIRE_BUILT_SUBPROCESS_RUNNER === '1'

describe.skipIf(!existsSync(builtEntry) && !required)('built subprocess runner entry', () => {
  it('reports the direct target outcome through the built private entry', async () => {
    if (!existsSync(builtEntry)) throw new Error(`required built subprocess runner is missing: ${builtEntry}`)
    const files = createRunnerFiles({
      argv: [process.execPath, '-e', 'process.exit(11)'],
      cwd: process.cwd(),
      env: {},
    })
    try {
      const result = spawnSync(process.execPath, [
        builtEntry,
        '--mode',
        'node',
        '--request',
        files.requestPath,
        '--events',
        files.eventsPath,
      ], { encoding: 'utf8', timeout: 10_000 })
      expect(result.error).toBeUndefined()
      const events = await readRunnerEventsAsync(files.eventsPath)
      expect(events).toHaveLength(2)
      expect(events[0]?.type).toBe('started')
      if (events[0]?.type !== 'started') throw new Error('expected started event')
      expect(events[0].pid).toBeGreaterThan(0)
      expect(events[1]).toEqual({ type: 'exit', exitCode: 11, signal: null })
    } finally {
      cleanupRunnerFiles(files)
    }
  })
})
