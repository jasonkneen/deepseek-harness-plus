#!/usr/bin/env node
/**
 * Experimental whole-session engine runner. Boots a composition whose agent
 * loop is NOT composed; the entire session runs through one delegation
 * backend — the official Claude Agent SDK (`claude-code`) or the official
 * `codex app-server` (`codex`) — with the harness owning the durable session:
 * the user prompt, the engine's final answer, and the turn outcome are logged
 * as ordinary session events, and the session is flushed to persistence
 * before exit. Native OAuth authenticates both engines; no key is required.
 *
 * Usage: `dsh-engine-session [--config path] <claude-code|codex> <task...>`
 * @module @deepseek-ai/dsh-engine-session-demo/bin
 */

import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createAssistantMessage, createUserMessage, textOfBlocks } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'

const NAME = 'dsh-engine-session'

const ENGINES = ['claude-code', 'codex'] as const
type Engine = (typeof ENGINES)[number]

/* v8 ignore start -- thin self-executing composition over the unit-tested
   dsh-app-boot helpers; exercised end-to-end by the keyed e2e */
installFailLoud(NAME)
const snapshotMode = process.env['DSH_SNAPSHOT']
if (snapshotMode !== 'replay') loadEnv(NAME)

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
  },
  allowPositionals: true,
  strict: true,
})

const engine = positionals[0] as Engine | undefined
const task = positionals.slice(1).join(' ').trim()

if (engine === undefined || !ENGINES.includes(engine)) {
  console.error(`usage: ${NAME} [--config path] <${ENGINES.join('|')}> <task...>`)
  process.exitCode = 1
} else if (task === '') {
  console.error(`${NAME}: a task is required after the engine name`)
  process.exitCode = 1
} else {
  const ctx = await boot(NAME, resolveConfigPath(values.config ?? './cordis.yml', snapshotMode))
  await ctx.get('loader')?.await()
  let failure: string | undefined
  try {
    failure = await runEngineSession(ctx, engine, task)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  await ctx.fiber.dispose()
  if (failure !== undefined) {
    console.error(`${NAME}: ${failure}`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */

/**
 * Run one whole session through the chosen engine and log it durably.
 * @param ctx - booted context carrying sessions and the subagent service.
 * @param engine - the delegation backend that executes the session.
 * @param task - the session's single user prompt.
 * @returns a failure message, or `undefined` on success.
 */
async function runEngineSession(ctx: Context, engine: Engine, task: string): Promise<string | undefined> {
  const sessions = ctx.get('sessions')
  const subagents = ctx.get('subagents')
  if (sessions === undefined || subagents === undefined) return 'sessions/subagents service is not composed'

  const session = sessions.create(SessionId(`session-${randomUUID()}`), { meta: { cwd: process.cwd() } })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })

  const run = await subagents.start(engine, {
    prompt: [{ type: 'text', text: task }],
    parent: { id: session.id, session: { header: { cwd: process.cwd() } } } as unknown as Agent,
    signal: new AbortController().signal,
  })
  const result = await run.result
  const text = textOfBlocks(result.output)

  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: engine, model: 'native' },
    }),
  }, { surfaceOp: 'append' })
  const reason: TurnEndReason = result.stopReason === 'completed'
    ? { kind: 'completed' }
    : { kind: 'error', error: { message: `engine ${engine} finished with stopReason ${result.stopReason}`, code: 'UNKNOWN' } }
  session.append('turn/end', { turn: 1, reason })
  await sessions.flush(session)
  await run.dispose()

  if (text === '') return `engine ${engine} returned no assistant text`
  console.log(text)
  return reason.kind === 'completed' ? undefined : `engine ${engine} did not complete (stopReason ${result.stopReason})`
}
