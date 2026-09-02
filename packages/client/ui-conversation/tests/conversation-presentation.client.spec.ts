import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationPresentationState } from '../src/client/conversation/presentation.ts'

function entry(event: SessionEvent): SessionEventLikeEntry {
  return { type: 'event', event }
}

function user(seq: number, text: string, surfaceOp: SessionEvent<'user/message'>['surfaceOp'] = 'append'): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: seq,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    surfaceOp,
  }
}

describe('ConversationPresentationState', () => {
  it('hides an edited raw range while exposing the replacement on the current surface', () => {
    const original = user(1, 'original')
    const answer = {
      type: 'assistant/message', seq: SessionSeq(2), time: 2,
      data: { turn: 1, step: 1, message: { id: 'a' as never, role: 'assistant' as const, content: [{ type: 'text' as const, text: 'old' }], source: { kind: 'model' as const, provider: 'p', model: 'm' } } },
      surfaceOp: 'append' as const,
      sourceEventSeqs: [],
    } satisfies SessionEvent<'assistant/message'>
    const replacement = {
      ...user(5, 'edited', { op: 'replace', start: original.seq, end: answer.seq }),
      sourceEventSeqs: [original.seq, answer.seq],
      conversationOp: { op: 'replace' as const, start: SessionSeq(0), end: SessionSeq(3) },
    }
    const state = new ConversationPresentationState()
    const entries = [
      entry({ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } }),
      entry(original),
      entry(answer),
      entry({ type: 'turn/end', seq: SessionSeq(3), time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
      entry({ type: 'turn/start', seq: SessionSeq(4), time: 4, data: { turn: 2 } }),
      entry(replacement),
    ]

    state.replace(entries)

    expect(entries.map(value => state.visible(value))).toEqual([false, false, false, false, true, true])
    expect([...state.snapshot().currentSurfaceSeqs]).toEqual([replacement.seq])
  })

  it('keeps compacted transcript events visible while removing them from current surface membership', () => {
    const original = user(0, 'original')
    const checkpoint = {
      ...user(1, 'summary', { op: 'replace', start: original.seq, end: original.seq }),
      sourceEventSeqs: [original.seq],
    }
    const state = new ConversationPresentationState()
    const entries = [entry(original), entry(checkpoint)]

    state.replace(entries)

    expect(entries.map(value => state.visible(value))).toEqual([true, true])
    expect([...state.snapshot().currentSurfaceSeqs]).toEqual([checkpoint.seq])
  })
})
