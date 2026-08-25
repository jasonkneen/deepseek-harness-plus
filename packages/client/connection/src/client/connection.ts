import type { HostDescription, IApiClient } from './api.ts'

/** Reconnect/backoff tunables (deployment-varying — no hardcoded tunables; these become the
 *  future `ctx.connection` plugin's Config). All fields optional; defaults below. */
export interface ConnectionConfig {
  /** First-retry backoff cap in ms (jittered: actual delay is cap/2..cap). */
  backoffBaseMs?: number
  /** Exponential growth factor per consecutive failed attempt. */
  backoffFactor?: number
  /** Upper bound for the backoff cap in ms. */
  backoffMaxMs?: number
  /** Maximum wait for the registered generation source's ready signal. */
  generationReadyTimeoutMs?: number
}

const CONNECTION_DEFAULTS: Required<ConnectionConfig> = {
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 10_000,
  generationReadyTimeoutMs: 3_000,
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

/** Coarse connection state for the UI: 'connected' after each generation's handshake,
 *  'reconnecting' the moment the generation fails (covers the whole backoff+retry span). */
export type ConnectionState = 'connected' | 'reconnecting'

/** Connection-generation callbacks owned by API Gateway. */
export interface ConnectionSinks {
  /** After the generation source is ready and host.describe succeeds, first connect included. */
  onConnected?: (description: HostDescription) => void
  /** Coarse state transitions (deduplicated: fires only on change). The initial pre-connect
   *  span reports nothing — the UI treats "no state yet" as connecting, not as an outage. */
  onStateChange?: (state: ConnectionState) => void
}

/**
 * One long-lived source defining a Connection generation. The source must
 * attach its incremental listeners before calling `ready`, then remain pending
 * until the generation is lost or `signal` aborts.
 * @param signal - cancellation for the current generation.
 * @param ready - one-shot report that incremental delivery is attached.
 * @returns a promise settling only when this generation ends or fails.
 */
export type ConnectionGenerationSource = (
  signal: AbortSignal,
  ready: () => void,
) => Promise<void>

/**
 * Opens the registered generation source, reconnecting with exponential backoff on loss.
 * State (generation/attempt) is instance-private, never in the store.
 * Sink exceptions do not kill the generation loop.
 */
export class ConnectionController {
  private generation = 0
  private attempt = 0
  private current: AbortController | null = null
  private running = false
  private lastState: ConnectionState | null = null
  private readonly config: Required<ConnectionConfig>

  constructor(
    private readonly api: IApiClient,
    private readonly source: ConnectionGenerationSource,
    private readonly sinks: ConnectionSinks = {},
    config: ConnectionConfig = {},
  ) {
    this.config = { ...CONNECTION_DEFAULTS, ...config }
  }

  /** Idempotent: begin the connect/pump/reconnect loop. */
  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  /** Stop the loop and abort the current generation source. */
  stop(): void {
    this.running = false
    this.current?.abort()
    this.current = null
  }

  private backoffDelay(attempt: number): number {
    const { backoffBaseMs, backoffFactor, backoffMaxMs } = this.config
    const cap = Math.min(backoffMaxMs, backoffBaseMs * backoffFactor ** Math.max(0, attempt - 1))
    return cap / 2 + Math.random() * (cap / 2)
  }

  /** Read through a method: stop() flips the flag across awaits, so narrowing from the loop condition must not stick. */
  private isRunning(): boolean {
    return this.running
  }

  /** Re-read both mutable liveness guards after a potentially reentrant sink. */
  private isGenerationActive(controller: AbortController): boolean {
    return this.isRunning() && !controller.signal.aborted
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const gen = ++this.generation
      const ac = new AbortController()
      this.current = ac

      let sourceReady = false
      let resolveReady!: () => void
      let rejectReady!: (error: Error) => void
      let rejectSourceLost!: (error: Error) => void
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const sourceLost = new Promise<never>((_resolve, reject) => {
        rejectSourceLost = reject
      })
      const reportReady = (): void => {
        sourceReady = true
        resolveReady()
      }

      const failed = new Promise<void>((resolve) => {
        const settle = (): void => {
          if (gen === this.generation && !ac.signal.aborted) ac.abort()
          resolve()
        }
        void Promise.resolve()
          .then(() => this.source(ac.signal, reportReady))
          .then(
            () => {
              const error = new Error('connection generation ended')
              if (!sourceReady) rejectReady(error)
              rejectSourceLost(error)
              settle()
            },
            (error: unknown) => {
              const failure = error instanceof Error
                ? error
                : new Error('connection generation failed', { cause: error })
              if (!sourceReady) rejectReady(failure)
              rejectSourceLost(failure)
              settle()
            },
          )
      })

      try {
        // The source reports ready only after its incremental listeners exist;
        // describe may complete in parallel, but consumers see neither result
        // until both sides of the baseline-plus-increment handshake are ready.
        const [description] = await Promise.race([
          Promise.all([
            this.api.host.describe({}, ac.signal),
            waitForReady(ready, this.config.generationReadyTimeoutMs, ac.signal),
          ]),
          sourceLost,
        ])
        const descriptionResult = description.result
        if (!descriptionResult.ok) {
          throw new Error(`host.describe failed: ${descriptionResult.error.code}: ${descriptionResult.error.message}`)
        }
        if (ac.signal.aborted) throw new Error('generation aborted during readiness handshake')
        this.attempt = 0
        this.emitState('connected')
        // A state sink may synchronously stop this controller. Do not publish
        // a description for a generation that no longer exists afterward.
        if (this.isGenerationActive(ac)) {
          this.callSink(() => { this.sinks.onConnected?.(descriptionResult.value) })
        }
      } catch {
        // Transport failure: treat as generation failure, fall through to the shared backoff.
        if (!ac.signal.aborted) ac.abort()
      }

      await failed
      if (!this.isRunning()) return
      this.emitState('reconnecting')
      this.attempt += 1
      console.warn(`[connection] connection lost, retry #${this.attempt}`)
      const idle = new AbortController()
      await sleep(this.backoffDelay(this.attempt), idle.signal)
    }
  }

  /** Deduplicated state emission (sink isolation applies). */
  private emitState(state: ConnectionState): void {
    if (this.lastState === state) return
    this.lastState = state
    this.callSink(() => this.sinks.onStateChange?.(state))
  }

  /** Sink exception isolation: a business-layer throw is logged only, never affecting pump or reconnect semantics. */
  private callSink(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      console.error('[connection] connection sink threw:', error)
    }
  }
}

/** Await source readiness without letting a stalled carrier wedge startup forever. */
function waitForReady(ready: Promise<void>, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      finish(new Error(`connection generation was not ready within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    const aborted = (): void => {
      finish(new Error('connection generation aborted', { cause: signal.reason }))
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', aborted)
      if (error === undefined) resolve()
      else reject(error)
    }
    signal.addEventListener('abort', aborted, { once: true })
    void ready.then(
      () => { finish() },
      (error: unknown) => {
        finish(error as Error)
      },
    )
  })
}
