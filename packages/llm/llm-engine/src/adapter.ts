/**
 * LLM-seam adapter for the local engine CLIs (Claude Code, Codex). Each
 * route answers one model call by delegating the latest user text to the
 * corresponding `ctx.subagents` backend, which runs the native CLI with its
 * OAuth state — no API key — and returns the final text as one text block.
 *
 * The engines are agents, not model endpoints: they execute their own tools
 * inside their own process, so the harness sees only the final answer and
 * the session log records text-only turns. The conversation history is NOT
 * sent to the engine; each call is a fresh run of the latest user message.
 * Auxiliary calls (compaction, session titles) are refused with an error
 * finish: they would spawn a full agent run for a side task.
 *
 * @module dsh-llm-engine/adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  ReasoningEffortId,
  resolveRetryPolicy,
  textOfBlocks,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmReasoningEffortInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Empty type import: declaration-merges the subagent service into the cordis
// Context so `ctx.get('subagents')` is typed at this call site.
import type {} from '@deepseek-ai/dsh-subagent'

/** The engine routes this adapter serves, matching the backend provider names. */
export const ENGINE_ROUTES = ['claude-code', 'codex'] as const
/** One engine route name from {@link ENGINE_ROUTES}. */
export type EngineRoute = (typeof ENGINE_ROUTES)[number]

/** Model id meaning "the CLI's own configured default" (no override sent). */
export const NATIVE_MODEL = 'native'

/**
 * Models each engine route advertises, with the capacity metadata the harness
 * needs (compaction). Claude models from the Claude Code model family; Codex
 * models from the installed 0.147.0 app-server's model set. `native` stays
 * selectable as the CLI default override-free choice.
 */
export const ENGINE_MODEL_CATALOG: Record<EngineRoute, readonly {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}[]> = {
  'claude-code': [
    { id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1_000_000, maxTokens: 128_000 },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', contextWindow: 1_000_000, maxTokens: 128_000 },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 1_000_000, maxTokens: 128_000 },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1_000_000, maxTokens: 128_000 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1_000_000, maxTokens: 128_000 },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 1_000_000, maxTokens: 64_000 },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200_000, maxTokens: 64_000 },
    { id: NATIVE_MODEL, name: 'Native default', contextWindow: 1_000_000, maxTokens: 128_000 },
  ],
  codex: [
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', contextWindow: 400_000, maxTokens: 128_000 },
    { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', contextWindow: 128_000, maxTokens: 32_000 },
    { id: NATIVE_MODEL, name: 'Native default', contextWindow: 400_000, maxTokens: 128_000 },
  ],
}

/** Selectable harness effort ids per engine route, in display order. */
export const ENGINE_EFFORTS: Record<EngineRoute, readonly { id: string; name: string }[]> = {
  'claude-code': [
    { id: 'off', name: 'Off (no extended thinking)' },
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
    { id: 'xhigh', name: 'XHigh' },
    { id: 'max', name: 'Max' },
  ],
  codex: [
    { id: 'off', name: 'Off (minimal)' },
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
  ],
}

/** Stable failure code for an engine turn that ended without a usable answer. */
export const ENGINE_FAILURE_CODE = 'ENGINE_FAILURE'
/** Stable failure code for auxiliary calls the engines do not serve. */
export const UNSUPPORTED_PURPOSE_CODE = 'UNSUPPORTED_PURPOSE'

/** Display names keyed by route. */
const ENGINE_NAMES: Record<EngineRoute, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

/** The cwd-bearing parent the backends need; engine runs happen in this process's cwd. */
function stubParent(): Agent {
  return { id: 'llm-engine-parent', session: { header: { cwd: process.cwd() } } } as unknown as Agent
}

/**
 * The engine-backed LLM adapter. Registers the `claude-code` and `codex`
 * routes on `ctx.llm`; each `stream()` call runs the local CLI through
 * `ctx.subagents` and translates the final answer into one text block.
 */
export class EngineLlmAdapter extends LlmAdapter {
  private readonly ctx: Context
  private readonly continuation: boolean
  /** Per harness session: the engine session id to resume on the next turn. */
  private readonly sessionsById = new Map<string, string>()

  /**
   * @param ctx - context carrying the subagent service at call time.
   * @param continuation - whether turns resume the engine's long-lived
   *   session (requires the backends' `continuation` option too).
   */
  constructor(ctx: Context, continuation: boolean) {
    super()
    this.ctx = ctx
    this.continuation = continuation
  }

  /**
   * The engine session id to resume for one harness session, or `undefined`
   * for a fresh run. Entries whose harness session has left the store are
   * dropped so a dead session cannot leak engine state.
   * @param sessionId - the harness session id stamped on the request.
   * @returns the recorded continuation id, if the session is still live.
   */
  private continuationFor(sessionId: string): string | undefined {
    const sessions = this.ctx.get('sessions')
    if (sessions !== undefined && sessions.get(SessionId(sessionId)) === undefined) {
      this.sessionsById.delete(sessionId)
      return undefined
    }
    return this.sessionsById.get(sessionId)
  }

  /** @inheritdoc */
  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: ENGINE_NAMES[provider as EngineRoute] }
  }

  /** @inheritdoc */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const catalog = ENGINE_MODEL_CATALOG[provider as EngineRoute]
    return Promise.resolve(catalog.map(entry => ({
      provider,
      id: entry.id,
      name: entry.name,
    })))
  }

  /** @inheritdoc */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = ENGINE_MODEL_CATALOG[provider as EngineRoute]
      .find(candidate => candidate.id === model)
    if (entry === undefined) {
      return Promise.reject(new Error(
        `engine provider ${JSON.stringify(provider)} does not serve model ${JSON.stringify(model)}`,
      ))
    }
    return Promise.resolve({
      provider,
      id: entry.id,
      name: entry.name,
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: entry.maxTokens,
      reasoning: {
        efforts: ENGINE_EFFORTS[provider as EngineRoute].map(effort => ({
          id: ReasoningEffortId(effort.id),
          name: effort.name,
        }) satisfies LlmReasoningEffortInfo),
        defaultEffort: ReasoningEffortId('high'),
      },
    })
  }

  /**
   * Engine runs must never be auto-retried: a retry would execute the CLI
   * twice. The default bounded policy would retry on transient codes, so this
   * adapter pins a zero-retry normal policy for both routes.
   * @param _provider - the engine route.
   * @returns a normal policy with `maxRetries: 0`.
   */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'llm-engine')
  }

  /**
   * Answer one model call by running the local engine CLI on the latest user
   * text. The response is emitted as a single assembled text block followed
   * by the terminal finish; the engine's own tool activity stays inside its
   * process and is never surfaced on this stream.
   * @param options - the model call; only `provider`, `messages`, and `signal` are used.
   * @returns the stream chunks for one engine run.
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== undefined) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: UNSUPPORTED_PURPOSE_CODE,
            message: `engine provider ${JSON.stringify(options.provider)} serves conversation turns only, not ${options.purpose} calls`,
          },
        },
      }
      return
    }
    const prompt = latestUserText(options.messages)
    if (prompt === '') {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'EMPTY_PROMPT', message: 'engine providers need a non-empty user message' },
        },
      }
      return
    }
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'NO_SUBAGENTS', message: 'subagents service is not composed' },
        },
      }
      return
    }
    const sessionKey = this.continuation && options.sessionId !== undefined
      ? options.sessionId
      : undefined
    const continueFrom = sessionKey === undefined ? undefined : this.continuationFor(sessionKey)
    const run = await subagents.start(options.provider, {
      prompt: [{ type: 'text', text: prompt }],
      parent: stubParent(),
      signal: options.signal ?? new AbortController().signal,
      ...continueFrom === undefined ? {} : { continueFrom },
      ...(options.model !== NATIVE_MODEL
        ? { agentOptions: { model: options.model } }
        : {}),
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    })
    // Stream the engine's live text deltas while the run settles.
    yield { type: 'block-start', index: 0, blockType: 'text' }
    let sawDelta = false
    if (run.updates !== undefined) {
      for await (const update of run.updates) {
        sawDelta = true
        yield { type: 'text-delta', index: 0, text: update.text }
      }
    }
    const result = await run.result
    if (sessionKey !== undefined && result.continuationId !== undefined) {
      this.sessionsById.set(sessionKey, result.continuationId)
    }
    await run.dispose()
    if (result.stopReason === 'aborted') {
      yield {
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: { code: 'ABORTED', message: 'engine run was cancelled' },
        },
      }
      return
    }
    if (result.stopReason !== 'completed') {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: ENGINE_FAILURE_CODE,
            message: `engine ${JSON.stringify(options.provider)} finished with stopReason ${result.stopReason}`,
          },
        },
      }
      return
    }
    const text = textOfBlocks(result.output)
    if (text === '') {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: EMPTY_RESPONSE_CODE,
            message: `engine ${JSON.stringify(options.provider)} returned no text`,
          },
        },
      }
      return
    }
    if (!sawDelta) yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * The text of the latest DIRECT human prompt in a conversation, or `''` when
 * there is none. The engines receive the latest instruction only; they never
 * see the conversation history. Synthetic context injections (AGENTS.md and
 * skill catalogs via `agent.inject()`, tool results) also ride user-role
 * messages with plugin/tool sources, so only `source.kind === 'user'`
 * messages qualify as instructions.
 * @param messages - the ordered conversation messages.
 * @returns the latest direct user text.
 */
function latestUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message === undefined) continue
    if (message.role !== 'user' || message.source.kind !== 'user') continue
    const text = textOfBlocks(message.content)
    if (text !== '') return text
  }
  return ''
}
