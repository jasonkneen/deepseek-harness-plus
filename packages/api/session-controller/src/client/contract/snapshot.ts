/** Session-owned observable state excluding Conversation target data. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientFailure } from './result.ts'

/** One transient inbox occurrence from the authoritative queue snapshot. */
export interface QueuedMessage {
  readonly id: MessageId
  readonly messageId: MessageId
  readonly placement: 'queued' | 'steering' | 'context'
  readonly content: readonly ContentBlock[]
  readonly preview: string
  readonly text: string | null
}

/** History-open lifecycle of a Session event window. */
export type OpenState = 'cold' | 'loading' | 'open' | 'error'

/** Send/stop failure surfaced by Session consumers. */
export interface PromptError {
  readonly op: 'send' | 'stop'
  readonly error: ClientFailure
}

/** Immutable Session lifecycle and control snapshot. */
export interface SessionSnapshot {
  readonly sessionId: SessionId
  readonly queue: readonly QueuedMessage[]
  readonly running: boolean
  readonly subagent: {
    readonly address: SubagentAddress
    /** Absent until the direct-parent catalog resolves. */
    readonly parentAvailable?: boolean
  } | null
  readonly removed: boolean
  readonly openState: OpenState
  readonly openError: ClientFailure | null
  readonly hasMore: boolean
  readonly loadingOlder: boolean
  readonly promptError: PromptError | null
  readonly blank: boolean
  readonly lastAgentError: string | null
  /** A prompt call has begun on this Client Session object. */
  readonly promptAttempted: boolean
  /** The first accepted prompt has not reached a durable `turn/start` event. */
  readonly awaitingFirstTurn: boolean
}
