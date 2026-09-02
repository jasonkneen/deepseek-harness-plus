/**
 * User-facing conversation generations over the append-only Session log.
 *
 * @module @deepseek-ai/dsh-session/conversation
 */

import type { ConversationOp, SessionEvent, SessionSeq, SurfaceEvent } from './types.ts'

/** One committed user-facing replacement and the event that committed it. */
export interface ConversationReplacement extends ConversationOp {
  /** Seq of the replacement `user/message`. */
  readonly seq: SessionSeq
}

/** A merged inclusive interval hidden from the current conversation. */
export interface ConversationHiddenRange {
  readonly start: SessionSeq
  readonly end: SessionSeq
}

/** Complete result of folding conversation replacements from one event window. */
export interface ConversationFoldResult {
  /** Replacement operations in event order. */
  readonly replacements: readonly ConversationReplacement[]
  /** Sorted, non-overlapping raw-event ranges hidden by those replacements. */
  readonly hiddenRanges: readonly ConversationHiddenRange[]
}

/**
 * Test whether an event commits a user-facing conversation replacement.
 * @param event - validated Session event.
 * @returns whether the event is a replacement `user/message` carrying `conversationOp`.
 */
export function isConversationReplacementEvent(
  event: SessionEvent,
): event is SurfaceEvent & { conversationOp: ConversationOp } {
  const conversationOp = (event as SessionEvent & { conversationOp?: { op?: unknown } }).conversationOp
  return event.type === 'user/message'
    && event.surfaceOp !== undefined
    && event.surfaceOp !== 'append'
    && conversationOp?.op === 'replace'
}

/**
 * Validate one candidate's conversation metadata against the preceding log.
 * @param log - accepted events preceding the candidate.
 * @param event - candidate event at `log.length`.
 */
export function validateConversationEvent(
  log: readonly SessionEvent[],
  event: SessionEvent,
): void {
  const op = (event as SessionEvent & { conversationOp?: unknown }).conversationOp
  if (op === undefined) return
  if (event.type !== 'user/message') {
    throw new Error(`session event "${event.type}" cannot carry conversationOp`)
  }
  if (event.surfaceOp === 'append' || event.surfaceOp === undefined) {
    throw new Error('conversation replacement requires a replacement surfaceOp')
  }
  if (op === null || typeof op !== 'object' || Array.isArray(op)
    || Object.keys(op).length !== 3 || (op as { op?: unknown }).op !== 'replace') {
    throw new Error('conversationOp must be an exact replace operation')
  }
  const replacement = op as { op: 'replace'; start?: unknown; end?: unknown }
  if (!Number.isSafeInteger(replacement.start) || (replacement.start as number) < 0
    || !Number.isSafeInteger(replacement.end)
    || (replacement.end as number) < (replacement.start as number)) {
    throw new Error('conversation replacement requires non-negative safe start <= end')
  }
  const start = replacement.start as number
  const end = replacement.end as number
  if (end >= event.seq || log[start]?.seq !== start || log[end]?.seq !== end) {
    throw new Error('conversation replacement must reference an existing earlier event range')
  }
}

/**
 * Fold replacement metadata into the current hidden raw-event ranges.
 * @param events - complete log or contiguous client window.
 * @returns replacement history and merged hidden ranges.
 */
export function foldConversation(events: readonly SessionEvent[]): ConversationFoldResult {
  const replacements: ConversationReplacement[] = []
  const ranges: ConversationHiddenRange[] = []
  for (const event of events) {
    if (!isConversationReplacementEvent(event)) continue
    const replacement = { seq: event.seq, ...event.conversationOp }
    replacements.push(replacement)
    ranges.push({ start: replacement.start, end: replacement.end })
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end)
  const hiddenRanges: ConversationHiddenRange[] = []
  for (const range of ranges) {
    const previous = hiddenRanges.at(-1)
    if (previous === undefined || range.start > previous.end + 1) {
      hiddenRanges.push({ ...range })
      continue
    }
    if (range.end > previous.end) {
      hiddenRanges[hiddenRanges.length - 1] = { start: previous.start, end: range.end }
    }
  }
  return { replacements, hiddenRanges }
}

/**
 * Test whether one raw event seq belongs to the current user-facing generation.
 * @param seq - raw Session event sequence number.
 * @param hiddenRanges - sorted, non-overlapping ranges from {@link foldConversation}.
 * @returns whether current conversation projections retain the event.
 */
export function isConversationSeqVisible(
  seq: number,
  hiddenRanges: readonly ConversationHiddenRange[],
): boolean {
  let low = 0
  let high = hiddenRanges.length - 1
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2)
    const range = hiddenRanges[middle] as ConversationHiddenRange
    if (seq < range.start) high = middle - 1
    else if (seq > range.end) low = middle + 1
    else return false
  }
  return true
}
