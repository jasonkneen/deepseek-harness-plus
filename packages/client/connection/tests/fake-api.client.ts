// Test-local programmable IApiClient fake (NOT the fixture: fixture is a demo
// data source on a real clock; behavior tests need per-case responses and
// deferred-controlled timing). The generation source is a hand pump.
import type { IApiClient, RpcResponse, SkillEntry } from '../src/client/api.ts'
import type { ConnectionGenerationSource } from '../src/client/connection.ts'
import { RpcId } from '../src/client/api.ts'

export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

/** Test-held settlement: the case decides when an RPC lands (history-pending injections etc.). */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let nextRpc = 0

export function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: RpcId(`fake-${nextRpc++}`), result: { ok: true, value } }
}


type StreamItem = { kind: 'end' } | { kind: 'fail'; error: unknown }

interface StreamConn {
  feed(item: StreamItem): void
}

export class FakeApiClient implements IApiClient {
  /** Chronological call record: [method, payload]. */
  readonly calls: { method: string; payload: unknown }[] = []

  // Programmable slots (defaults answer OK-empty); reassign per case.
  onDescribe: (payload: unknown) => Promise<RpcResponse<{
    version: string
    cwd: string
    attachedSessions: number
    home: string
    canOpenPath: boolean
  }>> =
    () => Promise.resolve(ok({
      version: '0-fake', cwd: '/f', attachedSessions: 0, home: '/h', canOpenPath: true,
    }))
  onOpenPath: (payload: unknown) => Promise<RpcResponse<{ opened: true }>> =
    () => Promise.resolve(ok({ opened: true as const }))

  private readonly generationConns: StreamConn[] = []

  readonly host: IApiClient['host'] = {
    describe: payload => this.record('host.describe', payload, this.onDescribe(payload)),
    openPath: payload => this.record('host.openPath', payload, this.onOpenPath(payload)),
  }

  // Payloads stay `unknown` (lint-lane note above); response rows are the real
  // wire shapes so cases can program catalogs and skill lists without casts.
  onSkillList: (payload: unknown) => Promise<RpcResponse<{ skills: SkillEntry[] }>>
    = () => Promise.resolve(ok({ skills: [] }))


  readonly agentPresets: IApiClient['agentPresets'] = {
    openDocument: (payload: { agentPreset: string }) =>
      this.record('agentPreset.openDocument', payload, Promise.resolve(ok({ opened: true as const }))),
  }

  readonly skills: IApiClient['skills'] = {
    list: (payload: unknown) => this.record('skill.list', payload, this.onSkillList(payload)),
  }

  readonly settings: IApiClient['settings'] = {
    openDocument: payload => this.record('settings.openDocument', payload, Promise.resolve(ok({ opened: true as const }))),
  }

  readonly llm: IApiClient['llm'] = {
    providers: payload => this.record('llm.providers', payload, Promise.resolve(ok({ providers: [] }))),
    models: payload => this.record('llm.models', payload, Promise.resolve(ok({
      default: { provider: 'fixture', model: 'fixture' },
      routableProviders: [],
      groups: [],
      failures: [],
    }))),
    discoverModels: payload => this.record('llm.discoverModels', payload, Promise.resolve(ok({ models: [] }))),
  }

  /** When true, the source never reports ready. */
  suppressGenerationReady = false

  /** When true, ready callbacks remain parked until the test releases them. */
  holdGenerationReady = false
  private heldOpens: (() => void)[] = []

  releaseGenerationReady(): void {
    const held = this.heldOpens
    this.heldOpens = []
    for (const fire of held) fire()
  }

  readonly generation: ConnectionGenerationSource = (signal, ready) =>
    this.openGeneration(signal, ready)

  /** End (clean close) or fail (throw) every open stream — reconnect-path material. */
  endStreams(): void {
    for (const conn of [...this.generationConns]) conn.feed({ kind: 'end' })
  }

  failStreams(error: unknown): void {
    for (const conn of [...this.generationConns]) conn.feed({ kind: 'fail', error })
  }

  get openGenerationCount(): number {
    return this.generationConns.length
  }

  callsOf(method: string): unknown[] {
    return this.calls.filter(c => c.method === method).map(c => c.payload)
  }

  private record<T>(method: string, payload: unknown, response: Promise<T>): Promise<T> {
    this.calls.push({ method, payload })
    return response
  }

  private async openGeneration(signal: AbortSignal, onOpen: () => void): Promise<void> {
    const inbox: StreamItem[] = []
    let wake: (() => void) | null = null
    const conn: StreamConn = {
      feed: (item) => {
        inbox.push(item)
        wake?.()
      },
    }
    this.generationConns.push(conn)
    if (this.holdGenerationReady) this.heldOpens.push(onOpen)
    else if (!this.suppressGenerationReady) onOpen()
    try {
      while (!signal.aborted) {
        while (inbox.length > 0) {
          const item = inbox.shift() as StreamItem
          if (item.kind === 'end') return
          if (item.kind === 'fail') throw item.error
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        wake = null
      }
    } finally {
      this.generationConns.splice(this.generationConns.indexOf(conn), 1)
    }
  }
}
