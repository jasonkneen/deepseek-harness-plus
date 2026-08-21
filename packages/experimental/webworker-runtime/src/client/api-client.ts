/**
 * Page-side API carrier over the postMessage tunnel. Only `doFetch` is
 * implemented: the streaming methods stay on `AbstractApiClient`'s default
 * `readSse`, which is exactly what the worker answers on the two event-stream
 * paths — so unary calls and downstream streams share one framing and neither
 * side needs a WebSocket.
 */
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { WorkerTunnel } from './client.ts'

/** API client whose requests travel the worker tunnel instead of the network. */
export class WorkerApiClient extends AbstractApiClient {
  private readonly tunnel: WorkerTunnel

  /**
   * Bind the carrier to a tunnel.
   * @param tunnel - page half of the worker tunnel.
   */
  constructor(tunnel: WorkerTunnel) {
    super()
    this.tunnel = tunnel
  }

  /**
   * Send one request through the tunnel.
   * @param input - request URL.
   * @param init - fetch init; the tunnel honours method, headers, body, and signal.
   * @returns the reconstructed response.
   */
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return this.tunnel.fetch(input, init)
  }
}
