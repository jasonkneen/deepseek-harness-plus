#!/usr/bin/env node
/**
 * Drive TWO turns of ONE harness session through the real composition with an
 * engine provider: the loop stamps the session id on both model calls, the
 * engine LLM adapter resumes the backend's long-lived session (Claude
 * `resume` / Codex `thread/resume`), and the engine must remember the first
 * turn. Prints both final answers as JSON.
 *
 * Usage: `node --import tsx memory-driver.ts <configPath> <engine> <secret>`
 * @module multi-provider-memory-driver
 */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { lastAssistantText, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'

const [configPath, engine, secret] = process.argv.slice(2)
if (configPath === undefined || engine === undefined || secret === undefined) {
  throw new Error('memory driver requires <configPath> <engine> <secret>')
}

const ctx = await boot('multi-provider-memory', resolveConfigPath(configPath, undefined))
try {
  const agents = ctx.get('agents')
  if (agents === undefined) throw new Error('agents service is not composed')
  const { agent } = await agents.create({
    sessionId: SessionId(`memory-${Date.now()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: engine, model: 'native' },
  })
  const answers: string[] = []
  for (const task of [
    `Remember this secret phrase and nothing else: ${secret}. Do not use tools.`,
    'What secret phrase did I ask you to remember? Reply with exactly that phrase and nothing else. Do not use tools.',
  ]) {
    const before = agent.session.events.length
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: task }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    answers.push(lastAssistantText(agent.session.events, before))
  }
  process.stdout.write(`${JSON.stringify({ answers }, null, 2)}\n`)
} finally {
  await ctx.fiber.dispose()
}
