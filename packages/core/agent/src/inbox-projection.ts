/** Inbox projection schema and its inferred wire value. */

import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

/** Wire validation for pending agent input reconstructed from durable inbox splices. */
export const inboxProjectionSchema = z.object({
  'next-turn': z.array(z.custom<UserMessage>()).readonly(),
  'next-step': z.array(z.custom<UserMessage>()).readonly(),
}).readonly()

/** Complete pending Inbox value reconstructed from durable splices. */
export type InboxState = z.infer<typeof inboxProjectionSchema>

/** Standard fold that reconstructs pending agent input from durable splices. */
export const inboxProjectionDefinition = {
  key: 'inbox',
  stateSchema: inboxProjectionSchema,
  init: (): InboxState => ({ 'next-turn': [], 'next-step': [] }),
  apply(state: InboxState, event) {
    if (event.type !== 'agent/inbox/spliced') return state
    const splice = event.data
    const next = state[splice.target].toSpliced(
      splice.start,
      splice.removedCount ?? 0,
      ...splice.inserted,
    )
    return splice.target === 'next-turn'
      ? { 'next-turn': next, 'next-step': state['next-step'] }
      : { 'next-turn': state['next-turn'], 'next-step': next }
  },
  wire: {
    viewSchema: inboxProjectionSchema,
    view: (state: InboxState) => state,
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'inbox', InboxState>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Pending agent input reconstructed from durable inbox splices. */
    inbox: InboxState
  }
}
