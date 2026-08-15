/**
 * Minimal Codex app-server 0.147.0 protocol adapter. The shared JSON-RPC
 * transport owns framing and request correlation; this module owns only the
 * product methods, current thread/turn association, unattended approval
 * responses, and terminal-answer selection.
 *
 * @module @deepseek-ai/dsh-subagent-codex/wire
 */

import type { Readable, Writable } from 'node:stream'

/** Map a harness effort id to the Codex app-server effort vocabulary. */
export function codexEffort(effort: string): string {
  switch (effort) {
    case 'off':
      return 'minimal'
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
      return 'high'
    default:
      throw new Error(`subagent-codex: unsupported reasoning effort ${JSON.stringify(effort)}`)
  }
}
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentUpdate } from '@deepseek-ai/dsh-subagent'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

type JsonObject = Record<string, unknown>

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`subagent-codex: app-server returned invalid ${label}`)
  }
  return value as JsonObject
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`subagent-codex: app-server returned invalid ${label}`)
  }
  return value
}

function unattendedDecision(params: JsonObject): 'cancel' | 'decline' {
  const available = params.availableDecisions
  if (available === undefined || available === null) return 'decline'
  if (Array.isArray(available)) {
    if (available.includes('cancel')) return 'cancel'
    if (available.includes('decline')) return 'decline'
  }
  throw new Error('subagent-codex: app-server offered no unattended approval decision')
}

function isContextWindowExceeded(turn: JsonObject): boolean {
  if (turn.status !== 'failed') return false
  const error = turn.error
  return error !== null
    && typeof error === 'object'
    && !Array.isArray(error)
    && (error as JsonObject).codexErrorInfo === 'contextWindowExceeded'
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed protocol and stream failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`subagent-codex: app-server request aborted: ${String(signal.reason)}`)
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {})
    throw abortError(signal)
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * One app-server connection and its single ephemeral thread/turn.
 *
 * The class deliberately exposes no generic request surface. Supporting
 * another product method must first become part of the provider contract.
 */
export class CodexAppServerWire {
  private readonly transport: JsonRpcLineTransport
  private readonly fatal = Promise.withResolvers<never>()
  private threadId: string | undefined
  private turnId: string | undefined
  private pendingTurnId: string | undefined
  private turnCompleted: PromiseWithResolvers<JsonObject> | undefined
  private readonly earlyTurnNotifications: Array<{
    readonly method: string
    readonly params: JsonObject
  }> = []
  private lastFinalAnswer: string | undefined
  private lastUnphasedAnswer: string | undefined
  private readonly updateQueue: SubagentUpdate[] = []
  private updateWaiter: { resolve: () => void } | undefined
  private updatesClosed = false
  private closed = false

  constructor(
    private readonly input: Readable,
    output: Writable,
    private readonly continuation: boolean,
  ) {
    this.transport = new JsonRpcLineTransport(input, output)
    // Fatal protocol state can arrive after the current guarded operation has
    // already settled. Keep the shared rejection observed without inserting
    // another promise-adoption hop into active races.
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method, params) => this.handleServerRequest(method, params))
    this.transport.onNotification((method, params) => {
      try {
        this.handleNotification(method, params)
      } catch (error: unknown) {
        this.fail(thrown(error))
      }
    })
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
    // Pipe errors can race protocol closure and process teardown. Retain both
    // error listeners for the lifetime of their per-run streams so no late
    // EPIPE or read failure becomes an unhandled EventEmitter error.
    output.on('error', this.onOutputError)
  }

  /** Start reading app-server frames. */
  start(): void {
    this.transport.start()
  }

  /**
   * Perform the required app-server initialize/initialized handshake.
   * @param signal - unpublished-start cancellation.
   */
  async initialize(signal: AbortSignal): Promise<void> {
    object(await this.guarded(this.transport.request('initialize', {
      clientInfo: {
        name: 'deepseek-harness',
        title: 'DeepSeek Harness',
        version: '0.0.1',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    }, signal), signal), 'initialize response')
    this.transport.notify('initialized')
    await this.guarded(this.transport.flush(), signal)
  }

  /**
   * Create (or resume) the run's private thread and retain its identity.
   * Ephemeral by default (one-shot posture); with continuation enabled the
   * thread persists and `continueFrom` resumes the earlier conversation via
   * `thread/resume`.
   * @param cwd - parent Session workspace.
   * @param continueFrom - engine thread id to resume, or `undefined` for a fresh thread.
   * @param signal - unpublished-start cancellation.
   */
  async startThread(cwd: string, continueFrom: string | undefined, signal: AbortSignal): Promise<void> {
    if (continueFrom !== undefined) {
      const response = object(await this.guarded(this.transport.request('thread/resume', {
        threadId: continueFrom,
        cwd,
      }, signal), signal), 'thread/resume response')
      const thread = object(response.thread, 'thread/resume thread')
      this.threadId = string(thread.id, 'thread/resume thread id')
      return
    }
    const response = object(await this.guarded(this.transport.request('thread/start', {
      cwd,
      ephemeral: !this.continuation,
    }, signal), signal), 'thread/start response')
    const thread = object(response.thread, 'thread/start thread')
    const id = string(thread.id, 'thread/start thread id')
    if (!this.continuation && thread.ephemeral !== true) {
      throw new Error('subagent-codex: app-server did not create an ephemeral thread')
    }
    this.threadId = id
  }

  /** Wake one pending update iterator consumer. */
  private wakeUpdates(): void {
    if (this.updateWaiter !== undefined) {
      this.updateWaiter.resolve()
      this.updateWaiter = undefined
    }
  }

  /** Live text updates while the run streams, terminating when the turn settles. */
  updates(): AsyncIterable<SubagentUpdate> {
    return {
      [Symbol.asyncIterator]: async function* (this: CodexAppServerWire) {
        while (true) {
          while (this.updateQueue.length > 0) {
            yield this.updateQueue.shift() as SubagentUpdate
          }
          if (this.updatesClosed || this.closed) return
          await new Promise<void>((resolve) => {
            this.updateWaiter = { resolve }
          })
        }
      }.bind(this),
    }
  }

  /**
   * Submit the one text-only task and wait for this thread/turn's authoritative
   * terminal notification.
   * @param texts - already validated task text blocks.
   * @param signal - local cancellation for the published run.
   * @returns the shared subagent result.
   */
  async runTurn(
    texts: readonly string[],
    signal: AbortSignal,
    model: string | undefined,
    effort: string | undefined,
  ): Promise<SubagentResult> {
    const completion = Promise.withResolvers<JsonObject>()
    this.turnCompleted = completion
    const threadId = this.threadId as string
    const response = object(await this.guarded(this.transport.request('turn/start', {
      threadId,
      input: texts.map(text => ({ type: 'text', text, text_elements: [] })),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort: codexEffort(effort) }),
    }, signal), signal), 'turn/start response')
    const turn = object(response.turn, 'turn/start turn')
    this.commitTurnId(string(turn.id, 'turn/start turn id'))

    const completed = await this.guarded(completion.promise, signal)
    const terminal = object(completed.turn, 'turn/completed turn')
    const status = terminal.status
    if (isContextWindowExceeded(terminal)) {
      return { output: this.collectOutput(), stopReason: 'max-tokens' }
    }
    if (status !== 'completed') {
      const detail = status === 'failed'
        ? `: ${JSON.stringify(terminal.error)}`
        : ''
      throw new Error(`subagent-codex: Codex turn ended with status ${String(status)}${detail}`)
    }
    const output = this.collectOutput()
    if (output.length === 0) {
      throw new Error('subagent-codex: Codex completed without a final answer')
    }
    return {
      output,
      stopReason: 'completed',
      ...(this.continuation && this.threadId !== undefined ? { continuationId: this.threadId } : {}),
    }
  }

  /**
   * Best-effort remote cancellation. Local settlement and process teardown
   * remain authoritative when the child no longer accepts protocol requests.
   */
  interrupt(): void {
    if (this.threadId === undefined || this.turnId === undefined || this.closed) return
    void this.transport.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.turnId,
    }).catch(() => {})
  }

  /**
   * The best non-commentary answer observed so far, preserving exact bytes.
   * @returns the selected final or nullable-phase text block, if any.
   */
  collectOutput(): ContentBlock[] {
    const selected = this.lastFinalAnswer ?? this.lastUnphasedAnswer
    return selected !== undefined && selected.trim().length > 0
      ? [{ type: 'text', text: selected }]
      : []
  }

  /** Detach JSON-RPC listeners and reject outstanding requests. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('end', this.onInputEnd)
    this.transport.close()
  }

  private async guarded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    const withFatal = Promise.race([this.fatal.promise, pending])
    return raceAbort(withFatal, signal)
  }

  private fail(error: Error): void {
    this.fatal.reject(error)
  }

  private readonly onInputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onOutputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onInputEnd = (): void => {
    this.fail(new Error('subagent-codex: app-server protocol stream closed'))
  }

  private observePendingTurnId(id: string): void {
    if (this.turnCompleted === undefined) {
      throw new Error('subagent-codex: app-server referenced a turn before turn/start')
    }
    if (this.pendingTurnId !== undefined && this.pendingTurnId !== id) {
      throw new Error('subagent-codex: app-server referenced conflicting turns')
    }
    this.pendingTurnId = id
  }

  private commitTurnId(id: string): void {
    if (this.pendingTurnId !== undefined && this.pendingTurnId !== id) {
      throw new Error('subagent-codex: turn/start response did not match the active turn')
    }
    this.turnId = id
    const notifications = this.earlyTurnNotifications.splice(0)
    for (const notification of notifications) {
      this.handleNotification(notification.method, notification.params)
    }
  }

  private validateRunIds(params: JsonObject, nullableTurn = false): void {
    if (params.threadId !== this.threadId) {
      throw new Error('subagent-codex: app-server request referenced another thread')
    }
    if (nullableTurn && params.turnId === null) return
    const id = string(params.turnId, 'server request turn id')
    if (this.turnId === undefined) {
      this.observePendingTurnId(id)
      return
    }
    if (id !== this.turnId) {
      throw new Error('subagent-codex: app-server request referenced another turn')
    }
  }

  private handleServerRequest(method: string, params: JsonObject): Promise<unknown> {
    try {
      switch (method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
          this.validateRunIds(params)
          return Promise.resolve({ decision: unattendedDecision(params) })
        case 'item/permissions/requestApproval':
          this.validateRunIds(params)
          return Promise.resolve({ permissions: {}, scope: 'turn' })
        case 'item/tool/requestUserInput':
          this.validateRunIds(params)
          return Promise.resolve({ answers: {} })
        case 'mcpServer/elicitation/request':
          this.validateRunIds(params, true)
          return Promise.resolve({ action: 'decline', content: null, _meta: null })
        default:
          throw new Error(`subagent-codex: unsupported app-server request ${JSON.stringify(method)}`)
      }
    } catch (error: unknown) {
      const normalized = thrown(error)
      this.fail(normalized)
      return Promise.reject(normalized)
    }
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (method === 'item/agentMessage/delta') {
      const threadId = string(params.threadId, 'item/agentMessage/delta thread id')
      if (threadId !== this.threadId) return
      const id = string(params.turnId, 'item/agentMessage/delta turn id')
      if (this.turnId === undefined) {
        if (this.turnCompleted !== undefined) {
          this.observePendingTurnId(id)
          this.earlyTurnNotifications.push({ method, params })
        }
        return
      }
      if (id !== this.turnId) return
      this.updateQueue.push({ kind: 'text-delta', text: string(params.delta, 'item/agentMessage/delta text') })
      this.wakeUpdates()
      return
    }
    if (method === 'turn/started') {
      const threadId = string(params.threadId, 'turn/started thread id')
      if (threadId !== this.threadId) return
      const turn = object(params.turn, 'turn/started turn')
      if (this.turnCompleted !== undefined && this.turnId === undefined) {
        this.observePendingTurnId(string(turn.id, 'turn/started turn id'))
      }
      return
    }
    if (method === 'item/completed') {
      const threadId = string(params.threadId, 'item/completed thread id')
      if (threadId !== this.threadId) return
      const id = string(params.turnId, 'item/completed turn id')
      if (this.turnId === undefined) {
        if (this.turnCompleted !== undefined) {
          this.observePendingTurnId(id)
          this.earlyTurnNotifications.push({ method, params })
        }
        return
      }
      if (id !== this.turnId) return
      const item = object(params.item, 'item/completed item')
      if (item.type !== 'agentMessage') return
      const text = typeof item.text === 'string'
        ? item.text
        : (() => { throw new Error('subagent-codex: app-server returned an invalid agent message') })()
      if (item.phase === 'final_answer') {
        this.lastFinalAnswer = text
      } else if (item.phase === null) {
        this.lastUnphasedAnswer = text
      } else if (item.phase !== 'commentary') {
        throw new Error(`subagent-codex: app-server returned an unknown agent message phase ${JSON.stringify(item.phase)}`)
      }
      return
    }
    if (method !== 'turn/completed') return
    this.updatesClosed = true
    this.wakeUpdates()
    const threadId = string(params.threadId, 'turn/completed thread id')
    if (threadId !== this.threadId) return
    const turn = object(params.turn, 'turn/completed turn')
    const id = string(turn.id, 'turn/completed turn id')
    const turnCompleted = this.turnCompleted
    if (turnCompleted === undefined) return
    if (this.turnId === undefined) {
      this.observePendingTurnId(id)
      this.earlyTurnNotifications.push({ method, params })
      return
    }
    if (id !== this.turnId) return
    if (!['completed', 'interrupted', 'failed'].includes(String(turn.status))) {
      throw new Error(`subagent-codex: app-server returned invalid terminal turn status ${String(turn.status)}`)
    }
    turnCompleted.resolve(params)
  }
}
