/**
 * Tunnel frame protocol between the page and the worker host. Frames cross
 * `postMessage`, so inbound frames are validated before use.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/transport/frames
 */

/** Request identifier minted by the page. */
export type TunnelRequestId = string | number

/** One request; `body` carries the raw bytes for methods that have one. */
export interface TunnelRequestFrame {
  readonly t: 'req'
  readonly id: TunnelRequestId
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: ArrayBuffer | undefined
}

/** Page-side cancellation of an in-flight request or stream. */
export interface TunnelAbortFrame {
  readonly t: 'abort'
  readonly id: TunnelRequestId
}

/** Frames the worker accepts. */
/**
 * First inbound frame: the image URL, the one input the worker assembly
 * takes from outside.
 */
export interface TunnelInitFrame {
  readonly t: 'init'
  readonly image: string
}

/** Every frame the page sends the worker. */
export type TunnelInboundFrame = TunnelInitFrame | TunnelRequestFrame | TunnelAbortFrame

/** Complete response for unary requests and static files. */
export interface TunnelResponseFrame {
  readonly t: 'res'
  readonly id: TunnelRequestId
  readonly status: number
  readonly headers: Record<string, string>
  readonly body?: ArrayBuffer | undefined
  /** Present when the worker itself refused the request, so the page can surface the reason. */
  readonly message?: string | undefined
}

/** Head of a streamed response, followed by chunks and one terminator. */
export interface TunnelResponseHeadFrame {
  readonly t: 'res-head'
  readonly id: TunnelRequestId
  readonly status: number
  readonly headers: Record<string, string>
}

/** One body chunk of a streamed response. */
export interface TunnelResponseChunkFrame {
  readonly t: 'res-chunk'
  readonly id: TunnelRequestId
  readonly chunk: ArrayBuffer
}

/** Normal end of a streamed response. */
export interface TunnelResponseEndFrame {
  readonly t: 'res-end'
  readonly id: TunnelRequestId
}

/** Failure of a streamed response after its head was sent. */
export interface TunnelResponseErrorFrame {
  readonly t: 'res-err'
  readonly id: TunnelRequestId
  readonly message: string
}

/** Frames the worker emits. */
export type TunnelOutboundFrame =
  | TunnelResponseFrame
  | TunnelResponseHeadFrame
  | TunnelResponseChunkFrame
  | TunnelResponseEndFrame
  | TunnelResponseErrorFrame

/**
 * Validate a `postMessage` payload as a tunnel frame.
 * @param data - Message data received by the worker.
 * @returns The frame.
 */
export function parseInboundFrame(data: unknown): TunnelInboundFrame {
  if (typeof data !== 'object' || data === null) {
    throw new Error(`webworker tunnel: message is not a frame: ${String(data)}`)
  }
  const frame = data as Record<string, unknown>
  if (frame.t === 'init') {
    if (typeof frame.image !== 'string') {
      throw new Error('webworker tunnel: init frame needs a string image url')
    }
    return { t: 'init', image: frame.image }
  }
  const id = frame.id
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new Error(`webworker tunnel: frame has no usable id: ${JSON.stringify(frame.id)}`)
  }
  if (frame.t === 'abort') return { t: 'abort', id }
  if (frame.t !== 'req') throw new Error(`webworker tunnel: unknown frame type ${JSON.stringify(frame.t)}`)
  if (typeof frame.method !== 'string' || typeof frame.url !== 'string') {
    throw new Error(`webworker tunnel: request ${String(id)} needs string method and url`)
  }
  if (typeof frame.headers !== 'object' || frame.headers === null) {
    throw new Error(`webworker tunnel: request ${String(id)} needs a headers object`)
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(frame.headers)) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value
  }
  const body = frame.body
  if (body !== undefined && !(body instanceof ArrayBuffer)) {
    throw new Error(`webworker tunnel: request ${String(id)} body must be an ArrayBuffer`)
  }
  return { t: 'req', id, method: frame.method, url: frame.url, headers, body }
}
