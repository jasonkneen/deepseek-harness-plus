#!/usr/bin/env node
/**
 * Delegate one task through a pack-composed backend without a parent model:
 * boot the real multi-provider leaf, start the named subagent provider
 * (`claude-code` or `codex`) with a cwd-bearing stub parent, and print the
 * settled result as JSON. The backends authenticate natively (Claude's
 * claude.ai OAuth, Codex's ChatGPT OAuth) — no key is passed or required.
 *
 * Usage: `node --import tsx delegate-driver.ts <configPath> <providerName> <task>`
 * @module multi-provider-delegate-driver
 */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { textOfBlocks } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'

const [configPath, providerName, task] = process.argv.slice(2)
if (configPath === undefined || providerName === undefined || task === undefined) {
  throw new Error('delegate driver requires <configPath> <providerName> <task>')
}

const ctx = await boot('multi-provider-delegate', resolveConfigPath(configPath, undefined))
try {
  const parent = {
    id: 'delegate-parent',
    session: { header: { cwd: process.cwd() } },
  } as unknown as Agent
  const run = await ctx.subagents.start(providerName, {
    prompt: [{ type: 'text', text: task }],
    parent,
    signal: new AbortController().signal,
  })
  const result = await run.result
  await run.dispose()
  const text = textOfBlocks(result.output)
  process.stdout.write(`${JSON.stringify({ stopReason: result.stopReason, output: text }, null, 2)}\n`)
} finally {
  await ctx.fiber.dispose()
}
