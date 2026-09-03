/**
 * Performance gate for opening a large released-v0 Session log through the
 * JSONL backend: the first `open()` migrates and publishes the current
 * generation; later opens decode the published generation. Both run in child
 * processes under a fixed heap limit so an allocation regression fails as an
 * out-of-memory exit instead of passing on a machine with more memory.
 */

import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OpenGenerationWorkerReport } from './open-generation.bench.worker.ts'
import { SYNTHETIC_SESSION_DIRECTORY, writeSyntheticReleasedV0Log } from './synthetic-released-v0-log.ts'

/** 200 turns × (500 text + 125 reasoning deltas): 127,400 released-v0 events in about 2.8 MB of JSONL. */
const SHAPE = { turns: 200, textDeltas: 500 } as const

/**
 * Wall-clock budget for the migrating first `open()`. The pre-stack backend
 * decoded the same bytes in about 35 ms on the reference machine; a whole
 * artifact migration that validates, transforms, publishes, and re-reads the
 * log under the heap limit below costs about 1 s there and about twice that
 * on the CI runner. The budget leaves headroom above that while staying far
 * below the ~5 s (~10 s on CI) that the repeated-snapshot implementation
 * needed.
 */
const MIGRATION_BUDGET_MS = 3_000

/**
 * Old-space limit for the migrating child process. Pre-stack decoding of the
 * same log completed under 128 MB; the repeated-snapshot migration exhausted
 * that heap. Holding the limit fixed keeps the gate independent of the
 * runner's physical memory.
 */
const MIGRATION_HEAP_LIMIT_MB = 128

/** Wall-clock budget for a fresh process opening the already published current generation. */
const STEADY_OPEN_BUDGET_MS = 500

/** Attempts per measurement; the gate compares the minimum so scheduler noise only adds. */
const ATTEMPTS = 3

const WORKER = join(import.meta.dirname, 'open-generation.bench.worker.ts')

interface WorkerRun {
  readonly report: OpenGenerationWorkerReport | undefined
  readonly exitCode: number | null
  readonly stderr: string
}

function runWorker(root: string, mode: 'migrate' | 'steady', heapLimitMb: number): Promise<WorkerRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      `--max-old-space-size=${String(heapLimitMb)}`,
      '--import',
      'tsx/esm',
      WORKER,
      root,
      mode,
    ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (exitCode) => {
      const line = stdout.trim().split('\n').at(-1)
      let report: OpenGenerationWorkerReport | undefined
      if (exitCode === 0 && line !== undefined && line.startsWith('{')) {
        report = JSON.parse(line) as OpenGenerationWorkerReport
      }
      resolve({ report, exitCode, stderr })
    })
  })
}

function requireReport(run: WorkerRun, label: string): OpenGenerationWorkerReport {
  if (run.report === undefined) {
    const lines = run.stderr.trim().split('\n')
    const fatal = lines.filter(line => /FATAL ERROR|heap limit|out of memory/i.test(line))
    const detail = (fatal.length > 0 ? fatal : lines.slice(-8)).join('\n')
    throw new Error(`${label} exited with ${String(run.exitCode)} under --max-old-space-size=${String(MIGRATION_HEAP_LIMIT_MB)}:\n${detail}`)
  }
  return run.report
}

describe('opening a large released-v0 Session log', () => {
  let scratch: string
  let sourcePath: string
  let sourceBytes = 0
  let sourceEvents = 0
  const migratedRoots: string[] = []

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-open-generation-bench-'))
    const written = await writeSyntheticReleasedV0Log(join(scratch, 'source'), SHAPE)
    sourcePath = written.path
    sourceBytes = written.bytes
    sourceEvents = written.events
  })

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it(`migrates ${String(SHAPE.turns)} turns of streamed replies within ${String(MIGRATION_BUDGET_MS)} ms under a ${String(MIGRATION_HEAP_LIMIT_MB)} MB heap`, async () => {
    const reports: OpenGenerationWorkerReport[] = []
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const root = join(scratch, `migrate-${String(attempt)}`)
      await mkdir(join(root, SYNTHETIC_SESSION_DIRECTORY), { recursive: true })
      await copyFile(sourcePath, join(root, SYNTHETIC_SESSION_DIRECTORY, 'session.jsonl'))
      reports.push(requireReport(await runWorker(root, 'migrate', MIGRATION_HEAP_LIMIT_MB), `migration attempt ${String(attempt)}`))
      migratedRoots.push(root)
      const files = (await readdir(join(root, SYNTHETIC_SESSION_DIRECTORY))).sort()
      expect(files).toEqual(['session.jsonl', 'session.v2.jsonl'])
    }
    const openMs = Math.min(...reports.map(report => report.openMs))
    const parseMs = Math.min(...reports.map(report => report.parseMs))
    console.log(JSON.stringify({
      benchmark: 'open-generation/migrate',
      sourceBytes,
      sourceEvents,
      currentEvents: reports[0]?.events,
      openMs: Math.round(openMs),
      parseMs: Math.round(parseMs),
      readMs: Math.round(Math.min(...reports.map(report => report.readMs))),
      heapUsedMb: Math.round(Math.max(...reports.map(report => report.heapUsedMb))),
      heapLimitMb: MIGRATION_HEAP_LIMIT_MB,
      budgetMs: MIGRATION_BUDGET_MS,
    }))
    expect(reports.every(report => report.headerVersion === 2)).toBe(true)
    expect(openMs).toBeLessThanOrEqual(MIGRATION_BUDGET_MS)
  })

  it(`opens the published current generation within ${String(STEADY_OPEN_BUDGET_MS)} ms`, async () => {
    expect(migratedRoots.length, 'a published current generation from the migration benchmark').toBeGreaterThan(0)
    const reports: OpenGenerationWorkerReport[] = []
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const root = migratedRoots[attempt % migratedRoots.length] as string
      reports.push(requireReport(await runWorker(root, 'steady', MIGRATION_HEAP_LIMIT_MB), `steady attempt ${String(attempt)}`))
    }
    const openMs = Math.min(...reports.map(report => report.openMs))
    console.log(JSON.stringify({
      benchmark: 'open-generation/steady',
      openMs: Math.round(openMs),
      readMs: Math.round(Math.min(...reports.map(report => report.readMs))),
      heapUsedMb: Math.round(Math.max(...reports.map(report => report.heapUsedMb))),
      budgetMs: STEADY_OPEN_BUDGET_MS,
    }))
    expect(openMs).toBeLessThanOrEqual(STEADY_OPEN_BUDGET_MS)
  })
})
