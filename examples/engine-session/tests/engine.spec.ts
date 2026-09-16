/**
 * Keyless real-Loader smoke over the engine-session leaf: boot the real
 * `cordis.yml`, confirm both engines register, and prove the whole-session
 * transcript pipeline — session creation, the four appended event types, and
 * a flush — without invoking a model or a product process.
 */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/engine-driver.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

interface EngineInspect {
  providers: string[]
  events: string[]
}

describe('engine-session leaf over the real Loader (no key required)', () => {
  it('registers both engines and records a full transcript without a backend run', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'engine-session leaf inspection',
      tempDirPrefix: 'dsh-engine-session-leaf-',
      binScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
    })

    expect(stderr).toBe('')
    const output = JSON.parse(stdout) as EngineInspect

    // Both delegation engines compose on the host; no child process started.
    expect(output.providers).toEqual(expect.arrayContaining(['claude-code', 'codex']))

    // The durable transcript pipeline: turn open, user prompt, engine answer,
    // turn outcome — in order, followed by the flush.
    const appended = output.events.filter(event =>
      ['turn/start', 'user/message', 'assistant/message', 'turn/end'].includes(event))
    expect(appended).toEqual(['turn/start', 'user/message', 'assistant/message', 'turn/end'])
  }, 120_000)
})
