/** Baseline budgets for long-history requests, tool continuation, and fork-child discovery. */

import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { ciTimeBudget, PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import type { ContinuationReport } from './agent-continuation.worker.ts'
import type { CatalogReport } from './child-catalog.worker.ts'
import type { ProfileReport } from './profile-continuation.worker.ts'
import { WORKLOAD } from './workload.ts'

const ATTEMPTS = 5
const WORKER_TIMEOUT_MS = 60_000
/** M4 Pro / Node 24.19 baseline expectations, before shared CI scaling and variance headroom. */
const EXPECTED_MS = { 'request-history': 220, 'tool-continuation': 340, catalog: 320, 'profile-continuation': 1_700 } as const
const EXPECTED_RETAINED_HEAP_MB = 23
const WORKERS = join(import.meta.dirname, '..', '.dsh-build', 'agent-continuation')

type Scenario = keyof typeof EXPECTED_MS
type Report = ContinuationReport | CatalogReport | ProfileReport

function workerName(scenario: Scenario): string {
  if (scenario === 'profile-continuation') return 'profile-continuation.worker.js'
  return scenario === 'catalog' ? 'child-catalog.worker.js' : 'agent-continuation.worker.js'
}

async function run<Output>(root: string, scenario: Scenario, mode: string): Promise<Output> {
  const outcome = await runBuiltBenchmarkWorker<Output>({
    worker: join(WORKERS, workerName(scenario)), args: [root, mode],
    timeoutMs: WORKER_TIMEOUT_MS, exposeGc: true,
  })
  if (outcome.timedOut || outcome.signal !== null || outcome.exitCode !== 0 || outcome.report === undefined) {
    throw new Error('backend worker failed: ' + JSON.stringify(outcome))
  }
  return outcome.report
}

function median(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number
}

describe('continuing tool-heavy Sessions with large histories', () => {
  let scratch: string | undefined
  const sources = new Map<Scenario, string>()

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-agent-continuation-bench-'))
    for (const scenario of ['request-history', 'catalog'] as const) {
      const root = join(scratch, 'source-' + scenario)
      await run(root, scenario, 'seed')
      sources.set(scenario, root)
    }
    sources.set('tool-continuation', sources.get('request-history') as string)
  })
  afterAll(async () => {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  })

  for (const scenario of ['request-history', 'tool-continuation', 'catalog', 'profile-continuation'] as const) {
    it(scenario, async () => {
      const samples: Report[] = []
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const root = join(scratch as string, scenario + '-' + String(attempt))
        if (scenario === 'profile-continuation') await mkdir(root)
        else await cp(sources.get(scenario) as string, root, { recursive: true })
        try { samples.push(await run<Report>(root, scenario, scenario)) }
        finally { await rm(root, { recursive: true, force: true }) }
      }
      const totalMs = samples.map(sample => sample.totalMs)
      const budgetMs = ciTimeBudget(EXPECTED_MS[scenario])
      const retainedHeapBudgetMb = EXPECTED_RETAINED_HEAP_MB * PERFORMANCE_BUDGET_HEADROOM
      console.log(JSON.stringify({
        benchmark: 'agent-continuation/' + scenario, workload: WORKLOAD,
        samples, totalMs: { min: Math.min(...totalMs), median: median(totalMs), max: Math.max(...totalMs) },
        budgetMs, ...(scenario === 'tool-continuation' ? { retainedHeapBudgetMb } : {}),
      }))
      expect(median(totalMs)).toBeLessThanOrEqual(budgetMs)
      if (scenario === 'tool-continuation') {
        expect(median((samples as ContinuationReport[]).map(sample => sample.retainedHeapMb)))
          .toBeLessThanOrEqual(retainedHeapBudgetMb)
      }
    })
  }
})
