/**
 * Keyed end-to-end: boot the real multi-provider leaf through the demo bin
 * and run one live task per provider, verifying the WORLD (the final assistant
 * text) rather than the model's claim. Each provider's suite self-skips
 * without its key, mirroring the repo's DEEPSEEK_API_KEY-gated e2e posture.
 * Keys resolve from the shell environment, then the root `.env`, then the
 * managed credentials document — the same precedence the credential seam uses
 * for per-request resolution.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const binScript = fileURLToPath(new URL('../../../packages/examples/multi-provider-demo/src/bin.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

/** One keyed provider scenario: route, model, and the env var carrying its key. */
interface ProviderScenario {
  provider: string
  model: string
  keyEnv: string
}

const SCENARIOS: ProviderScenario[] = [
  { provider: 'google', model: 'gemini-2.5-flash', keyEnv: 'GOOGLE_API_KEY' },
  { provider: 'minimax', model: 'MiniMax-M3', keyEnv: 'MINIMAX_API_KEY' },
  { provider: 'kimi-coding', model: 'kimi-for-coding', keyEnv: 'KIMI_CODING_API_KEY' },
]

/**
 * Resolve one credential the way the harness would: shell environment, then
 * the gitignored root `.env`, then the managed credentials document.
 * @param name - the credential's env-var name.
 * @returns the resolved value, or `undefined` when absent everywhere.
 */
function resolveCredential(name: string): string | undefined {
  if (process.env[name] !== undefined && process.env[name] !== '') return process.env[name]
  try {
    const rootEnv = readFileSync(fileURLToPath(new URL('../../../.env', import.meta.url)), 'utf8')
    const match = rootEnv.match(new RegExp(`^${name}=(.+)$`, 'm'))
    if (match !== null) return match[1]!.trim()
  } catch {
    // No root .env — fine, the environment or credentials doc may still carry it.
  }
  try {
    const doc = yaml.load(readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')) as Record<string, unknown>
    const value = doc[name]
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

const TASK = 'Reply with exactly: PONG'

describe.each(SCENARIOS)('live turn on $provider ($keyEnv)', ({ provider, model, keyEnv }) => {
  const key = resolveCredential(keyEnv)
  describe.skipIf(key === undefined)(`provider ${provider}`, () => {
    it('answers PONG through the real composition', async () => {
      const { stdout, stderr } = await runLoaderSmoke({
        label: `multi-provider live ${provider}`,
        tempDirPrefix: `dsh-multi-provider-${provider}-`,
        binScript,
        configPath,
        binArgs: ['--config', configPath, 'run', '--provider', provider, '--model', model, ...TASK.split(' ')],
        tsconfigPath: repoTsconfig,
        env: { [keyEnv]: key },
      })
      expect(stderr).toBe('')
      expect(stdout.trim()).toBe('PONG')
    }, 180_000)
  })
})
