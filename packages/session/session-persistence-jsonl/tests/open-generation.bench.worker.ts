/**
 * Child-process worker for the open-generation benchmark: opens one Session
 * through the JSONL backend under the caller's heap limit and reports timings
 * as one JSON line. Arguments: `<root> <mode>` where mode is `migrate`
 * (release-v0 source only) or `steady` (published current generation).
 */

import { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SYNTHETIC_SESSION_DIRECTORY, SYNTHETIC_SESSION_ID } from './synthetic-released-v0-log.ts'

/** Timings printed by the worker. */
export interface OpenGenerationWorkerReport {
  readonly mode: 'migrate' | 'steady'
  /** `open()` wall time; for `migrate` this includes publishing the current generation. */
  readonly openMs: number
  /** `read()` of the complete current event list after `open()`. */
  readonly readMs: number
  /** `JSON.parse` of every source line, as the pure parsing floor of the same bytes. */
  readonly parseMs: number
  readonly events: number
  readonly headerVersion: number
  readonly heapUsedMb: number
}

const [root, mode] = process.argv.slice(2)
if (root === undefined || (mode !== 'migrate' && mode !== 'steady')) {
  throw new Error('usage: open-generation.bench.worker.ts <root> migrate|steady')
}

const sourceText = await readFile(join(root, SYNTHETIC_SESSION_DIRECTORY, 'session.jsonl'), 'utf8')
const parseStarted = performance.now()
for (const line of sourceText.split('\n')) {
  if (line.length > 0) JSON.parse(line)
}
const parseMs = performance.now() - parseStarted

const ctx = new Context()
await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
const openStarted = performance.now()
const handle = await ctx.sessionPersistence.open(SessionId(SYNTHETIC_SESSION_ID), 'read')
const openMs = performance.now() - openStarted
const readStarted = performance.now()
const events = await handle.read()
const readMs = performance.now() - readStarted
await handle.close()
if (handle.header.version !== SESSION_FORMAT_VERSION) {
  throw new Error(`expected current format v${SESSION_FORMAT_VERSION}, opened v${handle.header.version}`)
}
const report: OpenGenerationWorkerReport = {
  mode,
  openMs,
  readMs,
  parseMs,
  events: events.length,
  headerVersion: handle.header.version,
  heapUsedMb: process.memoryUsage().heapUsed / 1_048_576,
}
process.stdout.write(`${JSON.stringify(report)}\n`)
process.exit(0)
