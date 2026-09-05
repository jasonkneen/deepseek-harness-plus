/** Deterministic released-v0 Zstandard Session input for opening benchmarks. */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { releasedV0SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { compressZstdFrame } from '../../packages/session/session-persistence-jsonl/src/zstd.ts'

/** Fixed workload parameters used by every Session-opening scenario. */
export interface SyntheticV0SessionShape {
  /** Completed turns, each with one user prompt and one streamed assistant reply. */
  readonly turns: number
  /** Text deltas per reply; each reply also contains one quarter as many reasoning deltas. */
  readonly textDeltas: number
}

/** Stable identity and storage location of the synthesized Session. */
export const SYNTHETIC_SESSION_ID = 'bench-session'
export const SYNTHETIC_SESSION_CWD = '/bench'
export const SYNTHETIC_SESSION_DIRECTORY = join('--bench--', SYNTHETIC_SESSION_ID)
export const SYNTHETIC_V0_FILENAME = 'session.jsonl.zstd'
export const SYNTHETIC_CURRENT_FILENAME = 'session.v2.jsonl.zstd'

const TIME_ZERO = 1_700_000_000_000
/** One body frame per row preserves the historical many-frame workload deterministically. */
const ROWS_PER_FRAME = 1

interface SyntheticEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly sourceEventSeqs?: readonly number[]
  readonly surfaceOp?: 'append'
}

/** Complete metadata returned after writing one synthetic source generation. */
export interface SyntheticV0SessionWrite {
  readonly path: string
  readonly compressedBytes: number
  readonly logicalBytes: number
  readonly events: number
  readonly rows: number
  readonly frames: number
}

function synthesizeEvents(shape: SyntheticV0SessionShape): readonly SyntheticEvent[] {
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
      id: `user-${String(turn)}`,
      role: 'user',
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
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
      const delta = `r${String(index)} `
      reasoning += delta
      chunk({ type: 'reasoning-delta', index: 0, text: delta })
    }
    chunk({ type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } })
    chunk({ type: 'block-start', index: 1, blockType: 'text' })
    let text = ''
    for (let index = 0; index < shape.textDeltas; index += 1) {
      const delta = `w${String(index)} `
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
        id: `assistant-${String(turn)}`,
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
 * Write one deterministic released-v0 Zstandard generation.
 * @param root - JSONL persistence root.
 * @param shape - workload size.
 * @returns physical and logical workload facts.
 */
export async function writeSyntheticReleasedV0Session(
  root: string,
  shape: SyntheticV0SessionShape,
): Promise<SyntheticV0SessionWrite> {
  const events = synthesizeEvents(shape)
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
  const headerLine = `${JSON.stringify(encoded.header)}\n`
  const bodyFrames: Buffer[] = []
  let logicalBytes = Buffer.byteLength(headerLine)
  for (let index = 0; index < encoded.rows.length; index += ROWS_PER_FRAME) {
    const rows = encoded.rows.slice(index, index + ROWS_PER_FRAME)
    const text = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
    logicalBytes += Buffer.byteLength(text)
    bodyFrames.push(await compressZstdFrame(text))
  }
  const physical = Buffer.concat([
    await compressZstdFrame(headerLine),
    ...bodyFrames,
  ])
  const directory = join(root, SYNTHETIC_SESSION_DIRECTORY)
  await mkdir(directory, { recursive: true })
  const path = join(directory, SYNTHETIC_V0_FILENAME)
  await writeFile(path, physical)
  return {
    path,
    compressedBytes: physical.byteLength,
    logicalBytes,
    events: events.length,
    rows: encoded.rows.length,
    frames: encoded.rows.length + 1,
  }
}
