/**
 * Page-side unary API carrier over the postMessage tunnel. Gateway Remote
 * streams use the tunnel's dedicated logical-stream frames instead of this
 * fetch-shaped API path.
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
