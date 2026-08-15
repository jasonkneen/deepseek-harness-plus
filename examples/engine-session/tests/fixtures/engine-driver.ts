#!/usr/bin/env node
/**
 * Inspect the engine-session leaf without invoking a model or a product
 * process: boot the real composition, confirm both engines register, create a
 * session, append the full transcript event sequence, flush, and print the
 * event types. Keyless: no backend run starts.
 *
 * Usage: `node --import tsx engine-driver.ts <configPath>`
 * @module engine-session-inspect-driver
 */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'

const configPath = process.argv[2]
if (configPath === undefined) {
  throw new Error('engine inspect driver requires a config path')
}

const ctx = await boot('engine-inspect', resolveConfigPath(configPath, undefined))
try {
  const sessions = ctx.get('sessions')
  const subagents = ctx.get('subagents')
  if (sessions === undefined || subagents === undefined) {
    throw new Error('sessions/subagents service is not composed')
  }
  const session = sessions.create(SessionId('session-inspect'), { meta: { cwd: process.cwd() } })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'probe' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'probe-answer' }],
      source: { provider: 'probe', model: 'probe' },
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await sessions.flush(session)
  process.stdout.write(`${JSON.stringify({
    providers: subagents.list(),
    events: session.events.map(event => event.type),
  }, null, 2)}\n`)
} finally {
  await ctx.fiber.dispose()
}
