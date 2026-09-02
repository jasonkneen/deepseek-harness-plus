/** Loaded-window model-surface and user-facing conversation visibility. */

import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  isConversationReplacementEvent,
  isConversationSeqVisible,
  type ConversationHiddenRange,
} from '@deepseek-ai/dsh-session/conversation'
import { isReplacementSurfaceEvent, isSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { ConversationPresentation } from '../contract/conversation.ts'

/** Mutable presentation state owned by one Session Conversation binding. */
export class ConversationPresentationState {
  private readonly currentSurfaceSeqs = new Set<number>()
  private readonly shadowedSurfaceSeqs = new Set<number>()
  private hiddenRanges: ConversationHiddenRange[] = []

  /**
   * Replace all loaded presentation facts from one contiguous event window.
   * @param entries - complete loaded event window.
   */
  replace(entries: readonly SessionEventLikeEntry[]): void {
    this.currentSurfaceSeqs.clear()
    this.shadowedSurfaceSeqs.clear()
    this.hiddenRanges = []
    this.apply(entries)
  }

  /**
   * Apply newly appended or prepended standard events to presentation state.
   * @param entries - newly loaded event entries.
   */
  apply(entries: readonly SessionEventLikeEntry[]): void {
    const events = entries
      .filter((entry): entry is Extract<SessionEventLikeEntry, { type: 'event' }> => entry.type === 'event')
      .map(entry => entry.event)
      .sort((left, right) => left.seq - right.seq)
    for (const event of events) {
      if (isReplacementSurfaceEvent(event)) {
        for (const seq of event.sourceEventSeqs ?? []) {
          this.shadowedSurfaceSeqs.add(seq)
          this.currentSurfaceSeqs.delete(seq)
        }
      }
      if (isSurfaceEvent(event) && !this.shadowedSurfaceSeqs.has(event.seq)) {
        this.currentSurfaceSeqs.add(event.seq)
      }
      if (isConversationReplacementEvent(event)) {
        this.addHiddenRange(event.conversationOp.start, event.conversationOp.end)
      }
    }
  }

  /**
   * Test whether one loaded entry belongs to the current user-facing generation.
   * @param entry - loaded event or packed chunk row.
   * @returns whether current Conversation targets may consume the entry.
   */
  visible(entry: SessionEventLikeEntry): boolean {
    return isConversationSeqVisible(entry.event.seq, this.hiddenRanges)
  }

  /**
   * Read the presentation data supplied to target builders.
   * @returns detached current model-surface membership.
   */
  snapshot(): ConversationPresentation {
    return { currentSurfaceSeqs: new Set(this.currentSurfaceSeqs) }
  }

  private addHiddenRange(start: ConversationHiddenRange['start'], end: ConversationHiddenRange['end']): void {
    const ranges = [...this.hiddenRanges, { start, end }]
      .sort((left, right) => left.start - right.start || left.end - right.end)
    const merged: ConversationHiddenRange[] = []
    for (const range of ranges) {
      const previous = merged.at(-1)
      if (previous === undefined || range.start > previous.end + 1) {
        merged.push({ ...range })
      } else if (range.end > previous.end) {
        merged[merged.length - 1] = { start: previous.start, end: range.end }
      }
    }
    this.hiddenRanges = merged
  }
}
