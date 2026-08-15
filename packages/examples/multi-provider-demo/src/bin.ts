#!/usr/bin/env node
/**
 * Boot the multi-provider pack demo from `cordis.yml`; usage is
 * `dsh-multi-provider-demo [--config path] providers` or
 * `dsh-multi-provider-demo [--config path] run --provider <name> [--model <id>] <task...>`.
 * Shared env loading, Loader guards, snapshot config selection, and settled-tree
 * boot live in dsh-app-boot. Replay skips `.env` and selects sibling
 * `cordis.snapshot.yml` so a stray key cannot trigger a model call; the
 * `providers` listing is keyless and deterministic in both modes. The run
 * command boots one fresh agent on the requested provider, drives the task to
 * quiescence, and prints the final assistant text.
 * @module @deepseek-ai/dsh-multi-provider-demo/bin
 */

import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { lastAssistantText, SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const NAME = 'dsh-multi-provider-demo'

/* v8 ignore start -- thin self-executing composition over the unit-tested
   dsh-app-boot helpers; exercised end-to-end by the snapshot suite and the
   keyed e2e */
installFailLoud(NAME)
const snapshotMode = process.env['DSH_SNAPSHOT']
if (snapshotMode !== 'replay') loadEnv(NAME)

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
    provider: { type: 'string' },
    model: { type: 'string' },
  },
  allowPositionals: true,
  strict: true,
})

const command = positionals[0]
const task = positionals.slice(1).join(' ').trim()

if (command === undefined || (command !== 'providers' && command !== 'run')) {
  console.error(`usage: ${NAME} [--config path] <providers|run> [--provider <name>] [--model <id>] [task...]`)
  process.exitCode = 1
} else {
  const ctx = await boot(NAME, resolveConfigPath(values.config ?? './cordis.yml', snapshotMode))
  await ctx.get('loader')?.await()
  let failure: string | undefined
  try {
    if (command === 'providers') {
      await listProviders(ctx)
    } else {
      failure = await runTask(ctx, {
        ...(values.provider === undefined ? {} : { provider: values.provider }),
        ...(values.model === undefined ? {} : { model: values.model }),
        task,
      })
    }
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
 * Print every registered provider route and its model catalog. Keyless and
 * deterministic: routes print in registration order, model ids sorted.
 * @param ctx - booted context carrying the LLM service.
 */
async function listProviders(ctx: Context): Promise<void> {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('llm service is not composed')
  for (const info of llm.listProviders()) {
    const models = await llm.listModels(info.id)
    const ids = models.map(model => model.id).sort()
    console.log(`provider: ${info.id}`)
    if (info.name !== info.id) console.log(`  name: ${info.name}`)
    console.log(`  models: ${ids.join(', ')}`)
  }
}

/**
 * Run one task on the requested provider and print the final assistant text.
 * Key-based providers (`google`, `minimax`, `kimi-coding`, `anthropic`, …)
 * route through the harness agent loop; the engine providers `claude-code`
 * and `codex` run the whole task through the delegation backend with native
 * OAuth — no key of any kind. The model is required for key-based providers
 * and ignored for engines (their native configuration chooses it).
 * @param ctx - booted context carrying agents, sessions, and the subagent service.
 * @param options - provider, optional model, and the task text.
 * @returns a failure message, or `undefined` on success.
 */
async function runTask(
  ctx: Context,
  options: { provider?: string; model?: string; task: string },
): Promise<string | undefined> {
  if (options.provider === undefined || options.provider === '') return 'run requires --provider <name>'
  if (options.task === '') return 'run requires a task after the flags'
  const agents = ctx.get('agents')
  if (agents === undefined) return 'agents service is not composed'
  // Engine routes serve exactly one model id ('native'); the persona's
  // {{model}} variable needs it at assembly time.
  const model = options.model === undefined || options.model === ''
    ? (options.provider === 'claude-code' || options.provider === 'codex' ? 'native' : undefined)
    : options.model
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: model === undefined
      ? { provider: options.provider }
      : { provider: options.provider, model },
  })
  const before = agent.session.events.length
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: options.task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  const text = lastAssistantText(agent.session.events, before)
  if (text === '') {
    // Fail loud with the durable turn outcome (e.g. MISSING_CREDENTIAL
    // naming the provider's unresolved key) instead of a generic empty reply.
    let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
    for (const event of agent.session.events) {
      if (event.seq < before) continue
      if (event.type === 'turn/end') reason = event.data.reason
    }
    if (reason?.kind === 'error') {
      return `provider ${JSON.stringify(options.provider)} failed: ${reason.error.code}: ${reason.error.message}`
    }
    return `provider ${JSON.stringify(options.provider)} returned no assistant text`
  }
  console.log(text)
  return undefined
}

