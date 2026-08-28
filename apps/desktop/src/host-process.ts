/** Upstream-Node child lifecycle and streaming custom-protocol carrier. */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  DESKTOP_HOST_PROTOCOL_VERSION,
  type DesktopHostCommand,
  type DesktopHostEvent,
} from './host-protocol.ts'

interface PendingResponse {
  readonly resolve: (response: Response) => void
  readonly reject: (error: Error) => void
  controller?: ReadableStreamDefaultController<Uint8Array>
  removeAbort?: () => void
}

function isCanonicalBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
}

function isDesktopHostEvent(message: unknown): message is DesktopHostEvent {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  switch (candidate.type) {
    case 'ready':
      return candidate.protocolVersion === DESKTOP_HOST_PROTOCOL_VERSION && typeof candidate.dshVersion === 'string'
    case 'response-start':
      return typeof candidate.id === 'string' && typeof candidate.status === 'number'
        && Array.isArray(candidate.headers)
        && candidate.headers.every(header => Array.isArray(header) && header.length === 2
          && typeof header[0] === 'string' && typeof header[1] === 'string')
    case 'response-chunk':
      return typeof candidate.id === 'string' && isCanonicalBase64(candidate.chunkBase64)
    case 'response-end':
      return typeof candidate.id === 'string'
    case 'response-error':
      return typeof candidate.id === 'string' && typeof candidate.message === 'string'
    case 'fatal':
      return typeof candidate.message === 'string'
    default:
      return false
  }
}

/** Ready facts reported by one installed dsh child. */
export interface DesktopHostReady {
  readonly protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  readonly dshVersion: string
}

/** One dsh backend running under the bundled upstream Node.js executable. */
export class DesktopHostProcess {
  private child: ChildProcess | undefined
  private readonly pending = new Map<string, PendingResponse>()
  private readyResolve!: (ready: DesktopHostReady) => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise = new Promise<DesktopHostReady>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private exitPromise: Promise<void> | undefined
  private stderr = ''

  /**
   * @param node - absolute bundled upstream Node.js executable.
   * @param projectDir - active or staged desktop npm project.
   * @param inspectPort - optional loopback inspector port for workspace development.
   */
  constructor(
    private readonly node: string,
    private readonly projectDir: string,
    private readonly inspectPort?: number,
  ) {}

  /** Start the child once and resolve only after its complete composition is active. */
  async start(): Promise<DesktopHostReady> {
    if (this.child !== undefined) return this.readyPromise
    const entry = join(this.projectDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'desktop-host.js')
    const child = spawn(this.node, [
      ...(this.inspectPort === undefined ? [] : [`--inspect=127.0.0.1:${String(this.inspectPort)}`]),
      entry,
      this.projectDir,
      ...(this.inspectPort === undefined ? [] : ['--allow-linked-profile']),
    ], {
      cwd: this.projectDir,
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => (
        name !== 'NODE_OPTIONS' && !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
      ))),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.stderr += chunk })
    child.stdout?.pipe(process.stdout)
    child.on('message', (message: unknown) => {
      if (!isDesktopHostEvent(message)) {
        this.fail(new Error('dsh desktop host sent an invalid IPC event'))
        child.kill('SIGTERM')
        return
      }
      this.handleMessage(message)
    })
    child.once('error', (error) => { this.fail(error) })
    this.exitPromise = new Promise<void>((resolve) => {
      child.once('exit', (code) => {
        const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
        if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with ${String(code)}${suffix}`))
        else this.fail(new Error(`dsh desktop host stopped${suffix}`))
        resolve()
      })
    })
    return this.readyPromise
  }

  /** Forward one `dsh-app://app` request to the child. */
  async fetch(request: Request): Promise<Response> {
    await this.start()
    const child = this.child
    if (child === undefined || !child.connected) throw new Error('dsh desktop host is unavailable')
    const id = randomUUID()
    const method = request.method.toUpperCase()
    const body = method === 'GET' || method === 'HEAD'
      ? undefined
      : new Uint8Array(await request.arrayBuffer())
    return new Promise<Response>((resolve, reject) => {
      const pending: PendingResponse = { resolve, reject }
      const abort = (): void => {
        this.send({ type: 'cancel', id })
        pending.controller?.error(request.signal.reason)
        this.pending.delete(id)
        reject(request.signal.reason instanceof Error ? request.signal.reason : new Error('request aborted'))
      }
      if (request.signal.aborted) {
        abort()
        return
      }
      request.signal.addEventListener('abort', abort, { once: true })
      pending.removeAbort = () => { request.signal.removeEventListener('abort', abort) }
      this.pending.set(id, pending)
      this.send({
        type: 'fetch',
        id,
        request: {
          url: request.url,
          method,
          headers: [...request.headers.entries()],
          ...(body === undefined ? {} : { bodyBase64: Buffer.from(body).toString('base64') }),
        },
      })
    })
  }

  /** Request graceful teardown, then wait for child exit. */
  async stop(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    if (child.connected) this.send({ type: 'shutdown' })
    const exited = this.exitPromise ?? Promise.resolve()
    const wait = (milliseconds: number): Promise<'timeout'> => new Promise((resolve) => {
      const timer = setTimeout(() => { resolve('timeout') }, milliseconds)
      timer.unref()
    })
    if (await Promise.race([exited.then(() => 'exit' as const), wait(10_000)]) === 'timeout') child.kill('SIGTERM')
    if (await Promise.race([exited.then(() => 'exit' as const), wait(5_000)]) === 'timeout') {
      child.kill('SIGKILL')
      this.child = undefined
      throw new Error('dsh desktop host did not stop after termination')
    }
    this.child = undefined
  }

  private send(message: DesktopHostCommand): void {
    const child = this.child
    if (child === undefined || !child.connected) throw new Error('dsh desktop host IPC is unavailable')
    child.send(message)
  }

  private handleMessage(message: DesktopHostEvent): void {
    switch (message.type) {
      case 'ready':
        this.readyResolve(message)
        return
      case 'response-start': {
        const pending = this.pending.get(message.id)
        if (pending === undefined) return
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => { pending.controller = controller },
          cancel: () => { this.send({ type: 'cancel', id: message.id }) },
        })
        pending.resolve(new Response(body, {
          status: message.status,
          headers: new Headers(message.headers.map(([name, value]) => [name, value] as [string, string])),
        }))
        return
      }
      case 'response-chunk':
        this.pending.get(message.id)?.controller?.enqueue(Buffer.from(message.chunkBase64, 'base64'))
        return
      case 'response-end': {
        const pending = this.pending.get(message.id)
        if (pending === undefined) return
        pending.controller?.close()
        pending.removeAbort?.()
        this.pending.delete(message.id)
        return
      }
      case 'response-error': {
        const pending = this.pending.get(message.id)
        if (pending === undefined) return
        const error = new Error(message.message)
        if (pending.controller === undefined) pending.reject(error)
        else pending.controller.error(error)
        pending.removeAbort?.()
        this.pending.delete(message.id)
        return
      }
      case 'fatal':
        this.fail(new Error(message.message))
        return
      default:
        message satisfies never
    }
  }

  private fail(error: Error): void {
    this.readyReject(error)
    for (const pending of this.pending.values()) {
      if (pending.controller === undefined) pending.reject(error)
      else pending.controller.error(error)
      pending.removeAbort?.()
    }
    this.pending.clear()
  }
}
