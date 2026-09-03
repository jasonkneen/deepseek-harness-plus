/**
 * Performance gate for the cold Client fold of a large Session format v2
 * history window: every registered Chat Definition runs over a synthesized
 * window in which each assistant reply embeds its compact stream. The gate
 * bounds the wall time and requires the fold to scale with the number of
 * compact stream records rather than with the number of streamed deltas.
 */

import { describe, expect, it } from 'vitest'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  ConversationNodeAssembler,
  inspectRequestPrompt,
  type ConversationNodeDefinition,
  type ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { assistantDefinition } from '../src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { commandDefinition } from '../src/client/conversation-nodes/command.ts'
import { compactionDefinition } from '../src/client/conversation-nodes/compaction.ts'
import { unknownFallbackDefinition } from '../src/client/conversation-nodes/fallback.ts'
import { nextStepInboxDefinition } from '../src/client/conversation-nodes/inbox.ts'
import { messageDefinition } from '../src/client/conversation-nodes/message.ts'
import { requestPromptDefinition } from '../src/client/conversation-nodes/request-prompt.ts'
import { retryDefinition } from '../src/client/conversation-nodes/retry.ts'
import { toolDefinition } from '../src/client/conversation-nodes/tool.ts'
import { turnErrorDefinition } from '../src/client/conversation-nodes/turn-error.ts'
import { turnMaxTokensDefinition } from '../src/client/conversation-nodes/turn-max-tokens.ts'
import { turnProcessDefinition } from '../src/client/conversation-nodes/turn-process.ts'
import { turnTailDefinition } from '../src/client/conversation-nodes/turn-tail.ts'

/** Replies in the folded window; each carries one reasoning block and one text block. */
const TURNS = 200

/** Text deltas per reply in the large workload; the reply also streams `deltas / 4` reasoning deltas. */
const LARGE_DELTAS = 2_000

/** Text deltas per reply in the small workload used as the scaling reference. */
const SMALL_DELTAS = 100

/**
 * Wall-clock budget for folding the large window (200 replies, 500,000 streamed
 * deltas compacted into 800 stream records). The pre-stack fold processed the
 * equivalent packed chunk rows in a few milliseconds; the budget leaves room
 * for the complete Definition set and slower CI hosts while staying below the
 * per-delta replay that needed hundreds of milliseconds for this window.
 */
const LARGE_FOLD_BUDGET_MS = 150

/**
 * Maximum ratio between folding the large and the small window. Both windows
 * hold the same number of events and compact records, so a fold that scales
 * with records stays near 1; a fold that replays every delta grows with the
 * 20× delta count.
 */
const MAX_DELTA_SCALING = 3

/** Attempts per workload; the gate compares minima so scheduler noise only adds. */
const ATTEMPTS = 3

const TIME_ZERO = 1_700_000_000_000

class BenchEventDefinitions {
  readonly definitions: readonly ConversationNodeDefinition[] = [
    nextStepInboxDefinition,
    messageDefinition,
    requestPromptDefinition(inspectRequestPrompt),
    assistantDefinition,
    turnProcessDefinition,
    toolDefinition,
    commandDefinition,
    compactionDefinition,
    retryDefinition,
    turnErrorDefinition,
    turnMaxTokensDefinition,
    turnTailDefinition,
  ]

  entries(): readonly ConversationNodeDefinition[] {
    return this.definitions
  }

  fallbackEntry(): ConversationNodeDefinition {
    return unknownFallbackDefinition
  }
}

class BenchViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [chatViewDefinition]
  }
}

function entry(seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}): SessionEventLikeEntry {
  return {
    type: 'event',
    event: { seq, time: TIME_ZERO + seq, type, data, ...extra } as unknown as SessionEvent,
  }
}

/**
 * Synthesize one v2 history window: `turns` completed replies whose compact
 * streams are accumulated from `deltas` text deltas and `deltas / 4`
 * reasoning deltas each.
 */
function synthesizeWindow(turns: number, deltas: number): { readonly entries: readonly SessionEventLikeEntry[]; readonly records: number } {
  const entries: SessionEventLikeEntry[] = []
  let seq = 0
  let records = 0
  const push = (type: string, data: unknown, extra: Record<string, unknown> = {}): void => {
    entries.push(entry(seq, type, data, extra))
    seq += 1
  }
  const reasoningDeltas = Math.floor(deltas / 4)
  for (let turn = 1; turn <= turns; turn += 1) {
    push('turn/start', { turn })
    push('user/message', {
      id: `user-${String(turn)}`,
      role: 'user',
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    push('step/start', { turn, step: 1 })
    const accumulator = new AssistantStreamAccumulator()
    let time = TIME_ZERO + seq * 1_000
    const stream = (chunk: StreamChunk): void => {
      accumulator.push({ time, chunk })
      time += 1
    }
    stream({ type: 'block-start', index: 0, blockType: 'reasoning' })
    let reasoning = ''
    for (let index = 0; index < reasoningDeltas; index += 1) {
      const delta = `r${String(index)} `
      reasoning += delta
      stream({ type: 'reasoning-delta', index: 0, text: delta })
    }
    stream({ type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } })
    stream({ type: 'block-start', index: 1, blockType: 'text' })
    let text = ''
    for (let index = 0; index < deltas; index += 1) {
      const delta = `w${String(index)} `
      text += delta
      stream({ type: 'text-delta', index: 1, text: delta })
    }
    stream({ type: 'block-end', index: 1, block: { type: 'text', text } })
    const usage = { inputTokens: 100, outputTokens: deltas }
    stream({ type: 'usage', usage })
    stream({ type: 'finish', reason: { kind: 'stop' } })
    const snapshot = accumulator.snapshot()
    records += snapshot.length
    push('assistant/message', {
      turn,
      step: 1,
      message: {
        id: `assistant-${String(turn)}`,
        role: 'assistant',
        content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text }],
        source: { kind: 'model', provider: 'bench', model: 'bench' },
      },
      usage,
      stream: snapshot,
    }, { surfaceOp: 'append' })
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { entries, records }
}

function foldOnce(entries: readonly SessionEventLikeEntry[]): { readonly ms: number; readonly nodes: number } {
  const started = performance.now()
  const assembler = new ConversationNodeAssembler(new BenchEventDefinitions(), new BenchViewDefinitions())
  assembler.replaceWindow(entries, false)
  assembler.activateTarget('chat')
  const snapshot = assembler.snapshot('chat') as ChatSnapshot | undefined
  return { ms: performance.now() - started, nodes: snapshot?.order.length ?? 0 }
}

function bestOf(entries: readonly SessionEventLikeEntry[]): { readonly ms: number; readonly nodes: number } {
  let best = foldOnce(entries)
  for (let attempt = 1; attempt < ATTEMPTS; attempt += 1) {
    const next = foldOnce(entries)
    if (next.ms < best.ms) best = next
  }
  return best
}

describe('cold Chat fold of a large v2 history window', () => {
  it(`folds ${String(TURNS)} replies with ${String(LARGE_DELTAS)} deltas each within ${String(LARGE_FOLD_BUDGET_MS)} ms and scales with compact records`, () => {
    const small = synthesizeWindow(TURNS, SMALL_DELTAS)
    const large = synthesizeWindow(TURNS, LARGE_DELTAS)
    expect(large.entries.length).toBe(small.entries.length)
    expect(large.records).toBe(small.records)

    const smallFold = bestOf(small.entries)
    const largeFold = bestOf(large.entries)
    const scaling = largeFold.ms / Math.max(smallFold.ms, 1)
    console.log(JSON.stringify({
      benchmark: 'conversation-fold/large-window',
      events: large.entries.length,
      compactRecords: large.records,
      streamedDeltas: TURNS * (LARGE_DELTAS + Math.floor(LARGE_DELTAS / 4)),
      chatNodes: largeFold.nodes,
      smallFoldMs: Math.round(smallFold.ms * 10) / 10,
      largeFoldMs: Math.round(largeFold.ms * 10) / 10,
      scaling: Math.round(scaling * 100) / 100,
      budgetMs: LARGE_FOLD_BUDGET_MS,
      maxScaling: MAX_DELTA_SCALING,
    }))
    expect(largeFold.nodes).toBeGreaterThan(0)
    expect(largeFold.ms).toBeLessThanOrEqual(LARGE_FOLD_BUDGET_MS)
    expect(scaling).toBeLessThanOrEqual(MAX_DELTA_SCALING)
  })
})
