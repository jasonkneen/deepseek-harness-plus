/**
 * settings domain contract: what remains of the web face of the user-settings
 * seam (`ctx.settings`) once the redacted read and the path-addressed write
 * moved to the `settings` Remote namespace. Only the local-document handoff
 * stays here, because opening a Host file is a platform action rather than a
 * settings read.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Settings-domain unary methods (the map keys settings.* of RpcMethodMap). */
export interface SettingsApi {
  /**
   * Materialize the configured local document when absent and ask the Host to
   * hand it to the platform text-document opener. macOS forces a text editor;
   * Linux and Windows use the desktop file association. The request carries
   * no path, so the browser cannot choose an arbitrary Host filesystem target.
   */
  openDocument(
    request: RpcRequest<{}>, signal: AbortSignal,
  ): Promise<RpcResponse<{ opened: true }>>
}
