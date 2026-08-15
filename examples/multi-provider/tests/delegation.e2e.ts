/**
 * Keyed-end-to-end for the delegation backends through the real pack
 * composition: boot the multi-provider leaf, start the `claude-code` (Agent
 * SDK) and `codex` (app-server) providers with native OAuth, and verify the
 * settled result. Each suite self-skips when its product CLI is absent or not
 * logged in; the providers themselves need no API key (native auth), and the
 * stub parent makes no model call.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/delegate-driver.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

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

interface DelegateOutput {
  stopReason: string
  output: string
}

const TASK = 'Reply with exactly: PONG. Do not use tools.'

describe('claude-code backend via the Claude Agent SDK (native OAuth)', () => {
  describe.skipIf(!productReady('claude', ['auth', 'status']))('claude logged in', () => {
    it('answers PONG through the real pack composition', async () => {
      const { stdout, stderr } = await runLoaderSmoke({
        label: 'multi-provider delegate claude-code',
        tempDirPrefix: 'dsh-multi-provider-claude-',
        binScript: driver,
        configPath,
        binArgs: [configPath, 'claude-code', TASK],
        tsconfigPath: repoTsconfig,
        processTimeoutMs: 240_000,
      })
      expect(stderr).toBe('')
      const result = JSON.parse(stdout) as DelegateOutput
      expect(result.stopReason).toBe('completed')
      expect(result.output.trim()).toBe('PONG')
    }, 180_000)
  })
})

describe('codex backend via codex app-server (native OAuth)', () => {
  describe.skipIf(!productReady('codex', ['login', 'status']))('codex logged in', () => {
    it('answers PONG through the real pack composition', async () => {
      const { stdout, stderr } = await runLoaderSmoke({
        label: 'multi-provider delegate codex',
        tempDirPrefix: 'dsh-multi-provider-codex-',
        binScript: driver,
        configPath,
        binArgs: [configPath, 'codex', TASK],
        tsconfigPath: repoTsconfig,
        processTimeoutMs: 240_000,
      })
      expect(stderr).toBe('')
      const result = JSON.parse(stdout) as DelegateOutput
      expect(result.stopReason).toBe('completed')
      expect(result.output.trim()).toBe('PONG')
    }, 180_000)
  })
})

// The same engines driven through the demo bin's unified `run --provider`
// surface (the "dedicated provider" CLI path): one command for key-based
// providers and OAuth engines alike.
describe.each([
  { engine: 'claude-code', bin: 'claude', authArgs: ['auth', 'status'], model: 'claude-haiku-4-5' },
  { engine: 'codex', bin: 'codex', authArgs: ['login', 'status'], model: 'gpt-5.3-codex-spark' },
] as const)('demo bin engine provider $engine', ({ engine, bin, authArgs, model }) => {
  describe.skipIf(!productReady(bin, authArgs))(`${bin} logged in`, () => {
    it('answers PONG via run --provider with an explicit model override', async () => {
      const { stdout, stderr } = await runLoaderSmoke({
        label: `multi-provider demo engine ${engine}`,
        tempDirPrefix: `dsh-multi-provider-demo-${engine}-`,
        binScript: fileURLToPath(new URL('../../../packages/examples/multi-provider-demo/src/bin.ts', import.meta.url)),
        configPath,
        binArgs: ['--config', configPath, 'run', '--provider', engine, '--model', model, ...TASK.split(' ')],
        tsconfigPath: repoTsconfig,
        processTimeoutMs: 240_000,
      })
      expect(stderr).toBe('')
      expect(stdout.trim()).toBe('PONG')
    }, 180_000)
  })
})

// Long-lived sessions: one harness session, two turns, and the engine must
// REMEMBER the first turn across the second (Claude `resume` / Codex
// `thread/resume` through the engine LLM adapter). This is the claim that
// engine turns are NOT fresh-per-turn — verified against the real CLIs.
describe.each([
  { engine: 'claude-code', bin: 'claude', authArgs: ['auth', 'status'] },
  { engine: 'codex', bin: 'codex', authArgs: ['login', 'status'] },
] as const)('engine long-lived session $engine', ({ engine, bin, authArgs }) => {
  describe.skipIf(!productReady(bin, authArgs))(`${bin} logged in`, () => {
    it('remembers a secret phrase across two turns of one session', async () => {
      const secret = `pineapple-${Math.random().toString(36).slice(2, 8)}`
      const { stdout, stderr } = await runLoaderSmoke({
        label: `engine memory ${engine}`,
        tempDirPrefix: `dsh-engine-memory-${engine}-`,
        binScript: fileURLToPath(new URL('./fixtures/memory-driver.ts', import.meta.url)),
        configPath,
        binArgs: [configPath, engine, secret],
        tsconfigPath: repoTsconfig,
        processTimeoutMs: 240_000,
      })
      expect(stderr).toBe('')
      const result = JSON.parse(stdout) as { answers: string[] }
      expect(result.answers).toHaveLength(2)
      expect(result.answers[0]!.length).toBeGreaterThan(0)
      // The engine answered turn 2 from its RESUMED conversation, not from
      // anything the harness sent (turn 2's prompt names no secret).
      expect(result.answers[1]!.toLowerCase()).toContain(secret)
    }, 240_000)
  })
})
