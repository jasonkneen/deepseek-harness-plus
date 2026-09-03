/**
 * Deterministic released-v0 Session log synthesized from fixed parameters.
 * The content is generated in-process (numbered prompts, counters, and
 * repeated tokens) so the benchmark input carries no recorded material.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { releasedV0SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'

/** Fixed workload parameters; every count below is derived from them. */
export interface SyntheticV0LogShape {
  /** Completed turns, each with one user prompt and one streamed assistant reply. */
  readonly turns: number
  /** `text-delta` chunks per reply; the reply also streams `textDeltas / 4` reasoning deltas. */
  readonly textDeltas: number
}

/** Session id and cwd used by every synthesized log. */
export const SYNTHETIC_SESSION_ID = 'bench-session'
export const SYNTHETIC_SESSION_CWD = '/bench'

/** Physical directory of the synthesized log below one JSONL root (project slug + session segment). */
export const SYNTHETIC_SESSION_DIRECTORY = join('--bench--', SYNTHETIC_SESSION_ID)

const TIME_ZERO = 1_700_000_000_000

interface SyntheticEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly sourceEventSeqs?: readonly number[]
  readonly surfaceOp?: 'append'
}

/**
 * Build the logical released-v0 events for one shape.
 * @param shape - fixed workload parameters.
 * @returns dense events in log order.
 */
export function synthesizeReleasedV0Events(shape: SyntheticV0LogShape): readonly SyntheticEvent[] {
  const events: SyntheticEvent[] = []
  let seq = 0
  let time = TIME_ZERO
  const push = (type: string, data: unknown, extra: Partial<SyntheticEvent> = {}): number => {
    events.push({ type, seq, time, data, ...extra })
    seq += 1
    time += 1
    return seq - 1
  }
  const reasoningDeltas = Math.floor(shape.textDeltas / 4)
  for (let turn = 1; turn <= shape.turns; turn += 1) {
    push('turn/start', { turn })
    push('user/message', {
      id: `user-${turn}`,
      role: 'user',
      content: [{ type: 'text', text: `prompt ${turn}` }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    push('step/start', { turn, step: 1 })
    const chunkSeqs: number[] = []
    const chunk = (value: unknown): void => {
      chunkSeqs.push(push('assistant/chunk', { turn, step: 1, chunk: value }))
    }
    chunk({ type: 'block-start', index: 0, blockType: 'reasoning' })
    let reasoning = ''
    for (let index = 0; index < reasoningDeltas; index += 1) {
      const delta = `r${index} `
      reasoning += delta
      chunk({ type: 'reasoning-delta', index: 0, text: delta })
    }
    chunk({ type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } })
    chunk({ type: 'block-start', index: 1, blockType: 'text' })
    let text = ''
    for (let index = 0; index < shape.textDeltas; index += 1) {
      const delta = `w${index} `
      text += delta
      chunk({ type: 'text-delta', index: 1, text: delta })
    }
    chunk({ type: 'block-end', index: 1, block: { type: 'text', text } })
    const usage = { inputTokens: 100, outputTokens: shape.textDeltas }
    chunk({ type: 'usage', usage })
    chunk({ type: 'finish', reason: { kind: 'stop' } })
    push('assistant/message', {
      turn,
      step: 1,
      message: {
        id: `assistant-${turn}`,
        role: 'assistant',
        content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text }],
        source: { kind: 'model', provider: 'bench', model: 'bench' },
      },
      usage,
    }, { sourceEventSeqs: chunkSeqs, surfaceOp: 'append' })
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return events
}

/**
 * Encode one shape as the released-v0 physical JSONL text (packed chunk rows).
 * @param shape - fixed workload parameters.
 * @returns the complete file text plus the logical event count.
 */
export function synthesizeReleasedV0LogText(shape: SyntheticV0LogShape): { readonly text: string; readonly events: number } {
  const events = synthesizeReleasedV0Events(shape)
  const header = {
    version: 0,
    id: SYNTHETIC_SESSION_ID,
    createdAt: TIME_ZERO,
    cwd: SYNTHETIC_SESSION_CWD,
    isSeeded: false,
    delegationDepth: 0,
  }
  const encoded = releasedV0SessionFormatCodec.encodeArtifact(
    { header, inheritedEventCount: 0, events: events as unknown as readonly SessionFormatEvent[] },
    { packChunks: true },
  )
  const lines = [JSON.stringify(encoded.header), ...encoded.rows.map(row => JSON.stringify(row))]
  return { text: `${lines.join('\n')}\n`, events: events.length }
}

/**
 * Write the synthesized raw v0 log where the JSONL backend expects it.
 * @param root - JSONL persistence root directory.
 * @param shape - fixed workload parameters.
 * @returns the written path, byte length, and logical event count.
 */
export async function writeSyntheticReleasedV0Log(
  root: string,
  shape: SyntheticV0LogShape,
): Promise<{ readonly path: string; readonly bytes: number; readonly events: number }> {
  const { text, events } = synthesizeReleasedV0LogText(shape)
  const directory = join(root, SYNTHETIC_SESSION_DIRECTORY)
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'session.jsonl')
  await writeFile(path, text)
  return { path, bytes: Buffer.byteLength(text), events }
}
