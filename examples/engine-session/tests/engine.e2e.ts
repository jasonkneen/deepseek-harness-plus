/**
 * Keyed end-to-end for the experimental whole-session engines: run one full
 * session through the real engine bin with the `claude-code` (Agent SDK) and
 * `codex` (app-server) backends under native OAuth, and verify the WORLD —
 * the final answer on stdout AND the durable session log under the leaf's
 * `.sessions` root — not the engine's self-report. Each suite self-skips when
 * its product CLI is absent or logged out. Runs under snapshot replay so the
 * persistence backend writes plain JSONL the test can read.
 */

import { readFile, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const binScript = fileURLToPath(new URL('../../../packages/examples/engine-session-demo/src/bin.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

/** Recursively collect every `.jsonl` file under `root` (persistence nests by cwd and session id). */
async function collectJsonl(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.jsonl')) found.push(path)
    }
  }
  await walk(root)
  return found
}

/** Whether a product CLI is installed and logged in (native OAuth ready). */
function productReady(bin: string, authArgs: readonly string[]): boolean {
  const which = spawnSync('which', [bin], { encoding: 'utf8' })
  if (which.status !== 0) return false
  const auth = spawnSync(bin, authArgs, { encoding: 'utf8', timeout: 15_000 })
  if (auth.status !== 0) return false
  // `codex login status` reports on stderr, `claude auth status` on stdout.
  const output = `${auth.stdout}${auth.stderr}`
  return output.includes('"loggedIn": true') || output.includes('Logged in')
}

const TASK = 'Reply with exactly: PONG. Do not use tools.'

interface EngineScenario {
  engine: string
  bin: string
  authArgs: readonly string[]
}

const SCENARIOS: EngineScenario[] = [
  { engine: 'claude-code', bin: 'claude', authArgs: ['auth', 'status'] },
  { engine: 'codex', bin: 'codex', authArgs: ['login', 'status'] },
]

describe.each(SCENARIOS)('whole-session engine $engine', ({ engine, bin, authArgs }) => {
  describe.skipIf(!productReady(bin, authArgs))(`${bin} logged in`, () => {
    it('answers PONG and records the transcript in the session log', async () => {
      const { stdout, stderr } = await runLoaderSmoke({
        label: `engine-session ${engine}`,
        tempDirPrefix: `dsh-engine-session-${engine}-`,
        binScript,
        configPath,
        binArgs: ['--config', configPath, engine, ...TASK.split(' ')],
        tsconfigPath: repoTsconfig,
        env: { DSH_SNAPSHOT: 'replay' },
        inspect: async (cwd) => {
          const logFiles = await collectJsonl(join(cwd, '.sessions'))
          expect(logFiles.length).toBeGreaterThan(0)
          const raw = await readFile(logFiles[0]!, 'utf8')
          const lines = raw.split('\n').filter(line => line !== '')
          const types = lines.map(line => (JSON.parse(line) as { type: string }).type)
          // The durable transcript: user prompt, engine answer, turn outcome.
          expect(types).toContain('user/message')
          expect(types).toContain('assistant/message')
          expect(types).toContain('turn/end')
          const turnEnd = lines.map(line => JSON.parse(line) as { type: string; data: { reason: { kind: string } } })
            .find(line => line.type === 'turn/end')
          expect(turnEnd?.data.reason.kind).toBe('completed')
        },
      })
      expect(stderr).toBe('')
      expect(stdout.trim()).toBe('PONG')
    }, 240_000)
  })
})
