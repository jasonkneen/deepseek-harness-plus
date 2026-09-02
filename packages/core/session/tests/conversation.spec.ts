import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionId,
  SessionSeq,
  type SessionEvent,
  foldConversation,
  isConversationReplacementEvent,
  isConversationSeqVisible,
} from '@deepseek-ai/dsh-session'

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('conversation replacements', () => {
  it('folds overlapping replacement ranges without deleting raw events', () => {
    const session = Session.create(SessionId('conversation-fold'))
    const first = session.append('user/message', message('first'), { surfaceOp: 'append' })
    const second = session.append('user/message', message('second'), { surfaceOp: 'append' })
    const replacement = session.append('user/message', message('rewrite'), {
      surfaceOp: { op: 'replace', start: first.seq, end: second.seq },
      sourceEventSeqs: [first.seq, second.seq],
      conversationOp: { op: 'replace', start: first.seq, end: second.seq },
    })
    const later = session.append('user/message', message('later'), { surfaceOp: 'append' })
    session.append('user/message', message('rewrite again'), {
      surfaceOp: { op: 'replace', start: replacement.seq, end: later.seq },
      sourceEventSeqs: [replacement.seq, later.seq],
      conversationOp: { op: 'replace', start: second.seq, end: later.seq },
    })

    const folded = foldConversation(session.snapshotEvents())
    expect(folded.replacements).toEqual([
      { seq: replacement.seq, op: 'replace', start: first.seq, end: second.seq },
      { seq: SessionSeq(later.seq + 1), op: 'replace', start: second.seq, end: later.seq },
    ])
    expect(folded.hiddenRanges).toEqual([{ start: first.seq, end: later.seq }])
    expect(isConversationSeqVisible(first.seq, folded.hiddenRanges)).toBe(false)
    expect(isConversationSeqVisible(replacement.seq, folded.hiddenRanges)).toBe(false)
    expect(isConversationSeqVisible(SessionSeq(later.seq + 1), folded.hiddenRanges)).toBe(true)
    expect(session.snapshotEvents()).toHaveLength(5)
  })

  it('requires a replacement user message and an existing prior range', () => {
    const session = Session.create(SessionId('conversation-validation'))
    const first = session.append('user/message', message('first'), { surfaceOp: 'append' })

    expect(() => session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: { id: 'assistant' as never, role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, {
      surfaceOp: { op: 'replace', start: first.seq, end: first.seq },
      sourceEventSeqs: [first.seq],
      conversationOp: { op: 'replace', start: first.seq, end: first.seq },
    })).toThrow('cannot carry conversationOp')

    expect(() => session.append('user/message', message('bad'), {
      surfaceOp: 'append',
      conversationOp: { op: 'replace', start: first.seq, end: first.seq },
    })).toThrow('requires a replacement surfaceOp')

    expect(() => session.append('user/message', message('future'), {
      surfaceOp: { op: 'replace', start: first.seq, end: first.seq },
      sourceEventSeqs: [first.seq],
      conversationOp: { op: 'replace', start: first.seq, end: 99 as never },
    })).toThrow('existing earlier event range')

    expect(() => session.append('user/message', message('malformed'), {
      surfaceOp: { op: 'replace', start: first.seq, end: first.seq },
      sourceEventSeqs: [first.seq],
      conversationOp: null as never,
    })).toThrow('exact replace operation')

    expect(() => session.append('user/message', message('negative'), {
      surfaceOp: { op: 'replace', start: first.seq, end: first.seq },
      sourceEventSeqs: [first.seq],
      conversationOp: { op: 'replace', start: -1 as never, end: first.seq },
    })).toThrow('non-negative safe start <= end')
  })

  it('recognizes only events carrying conversation metadata', () => {
    const session = Session.create(SessionId('conversation-guard'))
    const first = session.append('user/message', message('first'), { surfaceOp: 'append' })
    const replacement = session.append('user/message', message('replacement'), {
      surfaceOp: { op: 'replace', start: first.seq, end: first.seq },
      sourceEventSeqs: [first.seq],
      conversationOp: { op: 'replace', start: first.seq, end: first.seq },
    })
    expect(isConversationReplacementEvent(first)).toBe(false)
    expect(isConversationReplacementEvent(replacement)).toBe(true)
  })

  it('keeps nested replacement ranges merged and checks membership by both sides', () => {
    const events = [
      {
        type: 'user/message', seq: SessionSeq(2), time: 2, data: message('wide'),
        surfaceOp: { op: 'replace' as const, start: SessionSeq(0), end: SessionSeq(1) },
        conversationOp: { op: 'replace' as const, start: SessionSeq(0), end: SessionSeq(1) },
      },
      {
        type: 'user/message', seq: SessionSeq(3), time: 3, data: message('nested'),
        surfaceOp: { op: 'replace' as const, start: SessionSeq(1), end: SessionSeq(1) },
        conversationOp: { op: 'replace' as const, start: SessionSeq(1), end: SessionSeq(1) },
      },
      {
        type: 'user/message', seq: SessionSeq(4), time: 4, data: message('same start'),
        surfaceOp: { op: 'replace' as const, start: SessionSeq(0), end: SessionSeq(0) },
        conversationOp: { op: 'replace' as const, start: SessionSeq(0), end: SessionSeq(0) },
      },
    ] satisfies SessionEvent[]
    const folded = foldConversation(events)

    expect(folded.hiddenRanges).toEqual([{ start: 0, end: 1 }])
    expect(isConversationSeqVisible(-1 as never, folded.hiddenRanges)).toBe(true)
    expect(isConversationSeqVisible(SessionSeq(2), folded.hiddenRanges)).toBe(true)
  })
})
