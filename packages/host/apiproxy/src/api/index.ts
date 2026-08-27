/**
 * apiproxy contract-layer barrel. api/ has zero Node dependencies and is
 * importable from the browser; the TypeScript interfaces are authoritative,
 * while HTTP supplies the carrier.
 */

import type { HostApi } from './host.ts'
import type { AgentPresetsApi } from './agent-presets.ts'
import type { SkillsApi } from './skills.ts'
import type { SettingsApi } from './settings.ts'
import type { LlmApi } from './llm.ts'
import type { DownloadsApi } from './downloads.ts'

/** Root interface of the unified API. New client-request domain = one new file pair + one field here + one map row. */
export interface ApiProxy {
  host: HostApi
  skills: SkillsApi
  agentPresets: AgentPresetsApi
  settings: SettingsApi
  llm: LlmApi
  /** Host-only download surfaces (GET, no wire envelope); absent from IApiClient. */
  downloads: DownloadsApi
}

// ---- Domain interfaces and payload entities ----
export type {
  ModelCatalog, ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  ModelReasoningEffort, ModelSelection,
} from '@deepseek-ai/dsh-api-session-controller/types'
export type { HostApi } from './host.ts'
export type { SkillsApi, SkillEntry } from './skills.ts'
export type { AgentPresetsApi } from './agent-presets.ts'
export type { SettingsApi } from './settings.ts'
export type { ConfigurableProviderView, DiscoveredModelView, LlmApi } from './llm.ts'
export type { DownloadsApi } from './downloads.ts'

// ---- Message layer: narrow forms (domain-signature view) ----
export type { RpcRequest, RpcResponse } from './rpc.ts'

// ---- Message layer: unary wire forms ----
export type {
  ClientRequest,
  RpcMessage,
  ServerResponse,
} from './rpc.ts'

// ---- Errors and ids ----
export { RpcId, transportError } from './rpc.ts'
export type { RpcError, RpcErrorCode, RpcErrorDetailsMap, RpcResult } from './rpc.ts'
export {
  clientRequestSchema,
  serverResponseSchema,
} from './rpc.schema.ts'

// ---- Method registry and derived generics ----
export type { RequestPayload, ResponseValue, RpcMethodMap } from './rpc-map.ts'
