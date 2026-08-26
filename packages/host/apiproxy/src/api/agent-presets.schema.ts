/**
 * agent-presets domain zod schemas (names derived from map keys:
 * agentPresetOpenDocumentRequestSchema / agentPresetOpenDocumentValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** agentPreset.openDocument request payload. */
export const agentPresetOpenDocumentRequestSchema = z.object({
  agentPreset: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'agentPreset.openDocument'>>>

/** agentPreset.openDocument response value. */
export const agentPresetOpenDocumentValueSchema = z.union([
  z.object({ opened: z.literal(true) }),
  z.object({ opened: z.literal(false), path: z.string() }),
]) satisfies z.ZodType<Wire<ResponseValue<'agentPreset.openDocument'>>>
