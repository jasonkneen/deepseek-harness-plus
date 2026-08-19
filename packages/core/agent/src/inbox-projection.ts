/** Inbox projection schema and its inferred wire value. */

import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import { z } from 'zod'

/** Wire validation for pending agent input reconstructed from durable inbox splices. */
export const inboxProjectionSchema = z.object({
  'next-turn': z.array(z.custom<UserMessage>()).readonly(),
  'next-step': z.array(z.custom<UserMessage>()).readonly(),
}).readonly()

/** Complete pending Inbox value reconstructed from durable splices. */
export type InboxState = z.infer<typeof inboxProjectionSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Pending agent input reconstructed from durable inbox splices. */
    inbox: InboxState
  }
}
