/**
 * One-shot Claude Code lifecycle: invoke the official Agent SDK, place its
 * real CLI process under the shared subprocess owner, map only strict SDK
 * success to completion, and dispose to whole-tree quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/run
 */

import { randomUUID } from 'node:crypto'
import {
  query as officialQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
  type SubagentUpdate,
} from '@deepseek-ai/dsh-subagent'
import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  claudeSpawnSpec,
  ManagedClaudeCodeProcess,
} from './process.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/* jscpd:ignore-start -- sibling providers intentionally keep product-private
 * run inputs and error normalization instead of adding a shared lifecycle owner. */
/** Fully resolved inputs for one official Claude Agent SDK query. */
export interface ClaudeCodeRunSpec {
  /** Parent Session workspace supplied to the SDK and real CLI. */
  readonly cwd: string
  /** Exact native Claude Code executable resolved from the host PATH. */
  readonly executable: string
  /** Explicit deployment/test environment layered after shared scrubbing. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared process-tree owner. */
  readonly disposeGraceMs: number
  /**
   * Whether runs persist their SDK session and can resume
   * (`persistSession: true` writes session state under the native CLI
   * config dir). Off by default: the one-shot posture touches no native
   * state. When on, `continueFrom` resumes the earlier conversation.
   */
  readonly continuation: boolean
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed SDK and subprocess failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}
/* jscpd:ignore-end */

/**
 * Validate and preserve the one-shot task before crossing the SDK boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact text sequence as one SDK prompt.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-claude-code: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-claude-code: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-claude-code: the one-shot task must not be empty')
  }
  return texts.join('')
}

/**
 * Strictly derive the only SDK result that can complete a shared run.
 * @param message - an official discriminated result union.
 * @returns exact final text for a successful, non-error result.
 */
export function successfulResult(message: SDKResultMessage): string {
  if (
    message.subtype !== 'success'
    || message.is_error
    || message.result.trim().length === 0
  ) {
    const detail = message.subtype === 'success'
      ? 'success result was marked as an error or contained no answer'
      : message.errors.join('; ') || message.subtype
    throw new Error(`subagent-claude-code: Claude Code failed: ${detail}`)
  }
  return message.result
}

/** A push channel whose async iterator drains live updates. */
export interface UpdateChannel {
  push(update: SubagentUpdate): void
  end(): void
  [Symbol.asyncIterator](): AsyncIterator<SubagentUpdate>
}

/**
 * Build a live update channel: pushed values buffer until the iterator
 * consumes them; `end()` terminates iteration.
 * @returns the push/end facade plus an async iterator over the stream.
 */
export function updateChannel(): UpdateChannel {
  const queue: SubagentUpdate[] = []
  let closed = false
  let waiter: { resolve: () => void } | undefined
  const wake = (): void => {
    if (waiter !== undefined) {
      waiter.resolve()
      waiter = undefined
    }
  }
  return {
    push(update) {
      queue.push(update)
      wake()
    },
    end() {
      closed = true
      wake()
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift() as SubagentUpdate
        }
        if (closed) return
        await new Promise<void>((resolve) => {
          waiter = { resolve }
        })
      }
    },
  }
}

/**
 * Consume the complete SDK stream, require one strict success plus normal
 * iterator completion, and surface live text deltas while the model streams.
 * @param query - published official SDK query.
 * @param channel - live update channel fed from the stream's text deltas.
 * @returns the completed shared result.
 */
export async function consumeClaudeQuery(
  query: AsyncIterable<SDKMessage>,
  channel: UpdateChannel,
): Promise<SubagentResult> {
  let answer: string | undefined
  let continuationId: string | undefined
  try {
    for await (const message of query) {
      if (message.type === 'stream_event' && message.event.type === 'content_block_delta'
        && message.event.delta.type === 'text_delta') {
        channel.push({ kind: 'text-delta', text: message.event.delta.text })
        continue
      }
      if (message.type !== 'result') continue
      answer = successfulResult(message)
      continuationId = message.session_id
    }
  } finally {
    channel.end()
  }
  if (answer === undefined) {
    throw new Error('subagent-claude-code: Claude Code ended without a result')
  }
  return {
    output: [{ type: 'text', text: answer }],
    stopReason: 'completed',
    ...continuationId === undefined ? {} : { continuationId },
  }
}

/**
 * The live update stream for one query: drains the channel fed by
 * {@link consumeClaudeQuery}.
 * @param channel - the run's update channel.
 * @returns the updates async iterable for the published run.
 */
export function claudeUpdates(channel: UpdateChannel): AsyncIterable<SubagentUpdate> {
  return {
    [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](),
  }
}

/**
 * Close the official query, terminate the managed process tree, and wait for
 * the subprocess owner to prove it is gone.
 * @param query - official SDK query, when creation reached that point.
 * @param child - shared-service handle that owns the CLI process tree.
 */
export async function disposeClaudeCodeChild(
  query: Pick<Query, 'close'> | undefined,
  child: SubprocessHandle,
): Promise<void> {
  const failures: Error[] = []
  try {
    query?.close()
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  if (child.pid > 0) {
    child.terminate()
    try {
      await child.waitForExit()
    } catch (error: unknown) {
      failures.push(thrown(error))
    }
  }
  try {
    await child.done
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  const firstFailure = failures[0]
  if (failures.length === 1 && firstFailure !== undefined) throw firstFailure
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'subagent-claude-code: query and process cleanup failed',
    )
  }
}

/**
 * Build the fixed official SDK options for one one-shot provider run.
 * @param spec - Workspace, environment, process service, and disposal policy.
 * @param controller - per-run cancellation owner.
 * @param capture - receives the real managed child synchronously from the SDK hook.
 * @returns options that inherit native settings while disabling persistence and user questions.
 */
/** Harness effort ids accepted for Claude Code, mapped to the SDK vocabulary. */
export const CLAUDE_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number]

/** Map a harness effort id to the SDK's `effort`/`thinking` options. */
export function claudeEffortOptions(effort: string | undefined): Pick<Options, 'effort' | 'thinking'> {
  switch (effort) {
    case undefined:
    case 'high':
      return {}
    case 'off':
      return { thinking: { type: 'disabled' } }
    case 'low':
      return { effort: 'low' }
    case 'medium':
      return { effort: 'medium' }
    case 'xhigh':
      return { effort: 'xhigh' }
    case 'max':
      return { effort: 'max' }
    default:
      throw new Error(`subagent-claude-code: unsupported reasoning effort ${JSON.stringify(effort)}`)
  }
}

export function claudeQueryOptions(
  spec: ClaudeCodeRunSpec,
  controller: AbortController,
  capture: (child: SubprocessHandle) => void,
  continueFrom: string | undefined,
  model: string | undefined,
  effort: string | undefined,
): Options {
  return {
    abortController: controller,
    cwd: spec.cwd,
    pathToClaudeCodeExecutable: spec.executable,
    env: { ...scrubbedParentEnv(), ...spec.env },
    persistSession: spec.continuation,
    ...(spec.continuation && continueFrom !== undefined ? { resume: continueFrom } : {}),
    ...(model !== undefined ? { model } : {}),
    ...claudeEffortOptions(effort),
    disallowedTools: ['AskUserQuestion'],
    spawnClaudeCodeProcess: (options: SpawnOptions) => {
      const child = spec.spawn(claudeSpawnSpec(options, spec.disposeGraceMs))
      capture(child)
      return new ManagedClaudeCodeProcess(child)
    },
  }
}

/**
 * Start one official Claude Agent SDK query and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after both Query and real CLI handle exist.
 */
export async function startClaudeCodeRun(
  request: SubagentStartRequest,
  spec: ClaudeCodeRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-claude-code: request was aborted before SDK startup')
  }
  if (request.continueFrom !== undefined && !spec.continuation) {
    throw new Error(
      'subagent-claude-code: continuation is disabled by configuration; enable the provider `continuation` option',
    )
  }

  const controller = new AbortController()
  const requestCancel = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('subagent-claude-code: run cancelled locally'))
    }
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let child: SubprocessHandle | undefined
  let query: Query | undefined
  const channel = updateChannel()
  try {
    query = officialQuery({
      prompt,
      options: claudeQueryOptions(
        spec,
        controller,
        (captured) => {
          child = captured
        },
        request.continueFrom,
        request.agentOptions?.model,
        request.reasoningEffort,
      ),
    })
    if (child === undefined || child.pid <= 0) {
      throw new Error(
        'subagent-claude-code: official SDK did not publish a controllable Claude Code process',
      )
    }
    if (controller.signal.aborted) {
      throw new Error('subagent-claude-code: request was aborted before SDK startup')
    }
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = controller.signal.aborted
    requestCancel()
    if (child !== undefined) {
      try {
        await disposeClaudeCodeChild(query, child)
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [thrown(error), thrown(disposeError)],
          'subagent-claude-code: startup failed and CLI cleanup also failed',
        )
      }
    } else if (query !== undefined) {
      try {
        query.close()
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [thrown(error), thrown(disposeError)],
          'subagent-claude-code: startup failed and query cleanup also failed',
        )
      }
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the request can abort while process cleanup is awaited.
    if (cancelledBeforeCleanup || request.signal.aborted) {
      throw new Error('subagent-claude-code: request was aborted before SDK startup')
    }
    throw thrown(error)
  }

  const publishedQuery = query
  const publishedChild = child
  const result = settleRunResult({
    attempt: () => consumeClaudeQuery(publishedQuery, channel),
    collectOutput: () => [],
    cancelled: () => controller.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: SessionId(randomUUID()),
    result,
    updates: claudeUpdates(channel),
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: () => disposeClaudeCodeChild(
      publishedQuery,
      publishedChild,
    ),
  })
}
