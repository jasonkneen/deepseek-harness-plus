/**
 * agent-presets domain contract: handing one preset's directory to the
 * platform opener, which is the only agent-preset call still carried here.
 *
 * The roster and its authoring calls are the AgentPresets service's own Remote
 * namespace. This one stays because the opener is a Host desktop integration
 * rather than a preset operation.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** agent-preset-domain unary methods (the map key agentPreset.* of RpcMethodMap). */
export interface AgentPresetsApi {
  /**
   * Hand one locally authored preset's DIRECTORY to the platform opener, for
   * editing the files, which are the only composition editor. The request
   * carries an id, never a path — the Host resolves it — so no browser
   * payload can select an arbitrary filesystem target. Where the deployment
   * has no native opener (`canOpenPath: false` on `host.describe`), the reply
   * carries the resolved directory for the surface to show as text instead.
   * Shipped presets are refused: their install is not the user's to manage.
   */
  openDocument(request: RpcRequest<{ agentPreset: string }>, signal: AbortSignal):
  Promise<RpcResponse<{ opened: true } | { opened: false; path: string }>>
}
