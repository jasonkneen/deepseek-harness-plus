/** Durable per-session state for the user-controlled model-selection opt-in. */

import type { Session } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records that this session's delegation tool exposes child provider,
     * model, and reasoning-effort selection. Appended before the first model
     * request; absence means the fixed-route definition. Log-only: it carries
     * no `surfaceOp` and never enters model history.
     */
    'subagent/model-selection-enabled': Record<string, never>
  }
}

/**
 * Whether a session log records the enabled model-selection definition.
 * @param session - session whose durable decision is read.
 * @returns whether model-selectable delegation is enabled for the session.
 */
export function hasSubagentModelSelection(session: Session): boolean {
  return session.events.some(event => event.type === 'subagent/model-selection-enabled')
}

/**
 * Append the enabled decision once, before its definition can reach a model request.
 * @param session - session receiving the enabled decision.
 */
export function recordSubagentModelSelection(session: Session): void {
  if (hasSubagentModelSelection(session)) return
  session.append('subagent/model-selection-enabled', {})
}
