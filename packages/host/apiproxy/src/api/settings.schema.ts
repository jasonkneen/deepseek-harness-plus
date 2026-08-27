/**
 * settings domain zod schemas (names derived from map keys:
 * settingsOpenDocumentRequestSchema / settingsOpenDocumentValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** settings.openDocument request payload. */
export const settingsOpenDocumentRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'settings.openDocument'>>>

/** settings.openDocument response value. */
export const settingsOpenDocumentValueSchema = z.object({
  opened: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'settings.openDocument'>>>
