/** Required browser budgets for opening, paging and continuing synthetic long history. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { chromium, type Page, type CDPSession } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from '../../apps/web/tests/scaffold.ts'
import { newEnglishPage } from '../../apps/web/tests/support.ts'
import { ciTimeBudget } from '../support/calibration.ts'
import { HISTORY_TURNS, SESSION_ID, FIRST, DONE, DELTAS, PACE_MS, syntheticHistory, syntheticReply } from './synthetic-history.ts'

const SAMPLES = 3
const TAIL = '[data-chat-flow-key^="9:turn-tail"]'
const REFERENCE = { open: 200, page: 260, trajectory: 160, first: 1100, streamTask: 1800, input: 500, streamWall: 1000 }
const REPLAY_DURATION_MS = (DELTAS + 4) * PACE_MS

async function painted(page: Page): Promise<void> {
  // Two rAF callbacks include a rendering opportunity, not a GPU presentation timestamp.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function measure(page: Page, action: () => Promise<void>): Promise<number> {
  const start = performance.now()
  await action()
  await painted(page)
  return performance.now() - start
}

async function taskMs(cdp: CDPSession): Promise<number> {
  const result = await cdp.send('Performance.getMetrics')
  const metric = result.metrics.find(metric => metric.name === 'TaskDuration')
  if (metric === undefined) throw new Error('Chromium TaskDuration missing')
  return metric.value * 1000
}

function median(values: number[]): number {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!
}

it('opens, pages, navigates and streams into a 240-turn browser history', async () => {
  if (webSnapshotMode() !== 'replay') throw new Error('browser benchmarks require keyless replay mode')
  const samples: { open: number; page: number; trajectory: number; first: number; streamTask: number; streamWall: number; input: number; inputOverlapped: boolean; heapMb: number; nodes: number }[] = []
  for (let sample = 0; sample < SAMPLES; sample++) {
    const failures: unknown[] = []
    const root = await mkdtemp(join(tmpdir(), 'dsh-browser-benchmark-'))
    try {
      const replayOverride = join(root, 'reply.json')
      await writeFile(replayOverride, JSON.stringify([{ kind: 'chunks', chunks: syntheticReply() }]))
      const scaffold = await launchWebScaffold({ replayFixture: join(root, 'override-only.jsonl'), replayOverride, paceMs: PACE_MS, replayContextWindow: 10000000 })
      try {
        const history = syntheticHistory()
        await seedSession(scaffold, history, SESSION_ID)
        console.log(JSON.stringify({ benchmark: 'long-session-browser/fixture', bytes: Buffer.byteLength(history) }))
        const browser = await chromium.launch({ headless: true })
        try {
          const page = await newEnglishPage(browser)
          const consoleWatch = watchConsole(page)
          page.setDefaultTimeout(30000)
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          expect(new URL(page.url()).origin).toBe(scaffold.baseUrl)
          console.log(JSON.stringify({ benchmark: 'long-session-browser/server', url: scaffold.baseUrl, browser: browser.version(), sample }))
          await page.waitForSelector('[class*="frame"]')
          await page.getByRole('treeitem').first().click()
          const result = page.getByRole('treeitem').nth(1)
          await result.waitFor()
          const open = await measure(page, async () => {
            await result.click()
            await page.locator(TAIL).last().waitFor()
            await page.locator('[data-composer-input][contenteditable="true"]').last().waitFor()
          })
          const pages: number[] = []
          const initialTurns = await page.locator(TAIL).count()
          expect(initialTurns).toBeGreaterThan(0)
          expect(initialTurns).toBeLessThan(HISTORY_TURNS)
          let count = initialTurns
          while (count < HISTORY_TURNS) {
            pages.push(await measure(page, async () => {
              await page.getByRole('button', { name: 'Load earlier', exact: true }).click()
              await page.waitForFunction(({ selector, previous }) => document.querySelectorAll(selector).length > previous, { selector: TAIL, previous: count })
            }))
            count = await page.locator(TAIL).count()
          }
          const trajectory = await measure(page, async () => {
            await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
            await page.getByRole('searchbox', { name: 'Search trajectory', exact: true }).waitFor()
            await page.getByRole('row').last().waitFor()
          })
          await page.getByRole('tab', { name: 'Chat', exact: true }).click()
          await page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length === expected, { selector: TAIL, expected: HISTORY_TURNS })
          const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
          await composer.fill('Continue the synthetic review and summarize the validation. '.repeat(30))
          const cdp = await page.context().newCDPSession(page)
          await cdp.send('Performance.enable')
          const beforeTask = await taskMs(cdp)
          const settled = scaffold.whenTurnSettled(60000).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          )
          const started = performance.now()
          await page.locator('[data-composer-seat]').getByRole('button', { name: 'Send message', exact: true }).click()
          const reply = page.locator('[data-chat-flow-kind="assistant-step"]').last()
          await reply.getByText(FIRST, { exact: false }).last().waitFor()
          await painted(page)
          const first = performance.now() - started
          await composer.evaluate((element, markers) => {
            element.addEventListener('input', (event) => {
              const transcript = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')).at(-1)?.textContent ?? ''
              element.setAttribute('data-benchmark-input-overlap', String(event.isTrusted && transcript.includes(markers.first) && !transcript.includes(markers.done)))
            }, { once: true })
          }, { first: FIRST, done: DONE })
          // Observe the actual trusted input event, not state before asynchronous click/typing.
          const input = await measure(page, async () => {
            await composer.click()
            await page.keyboard.type('next synthetic question')
            await expect.poll(() => composer.textContent()).toBe('next synthetic question')
          })
          const inputOverlapped = await composer.getAttribute('data-benchmark-input-overlap') === 'true'
          expect(inputOverlapped).toBe(true)
          await reply.getByText(DONE, { exact: false }).last().waitFor()
          const settlement = await settled
          if (!settlement.ok) throw settlement.error
          await page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length === expected, { selector: TAIL, expected: HISTORY_TURNS + 1 })
          await painted(page)
          const streamWall = performance.now() - started
          const streamTask = await taskMs(cdp) - beforeTask
          await cdp.send('HeapProfiler.collectGarbage')
          const metrics = (await cdp.send('Performance.getMetrics')).metrics
          const heap = metrics.find(metric => metric.name === 'JSHeapUsedSize')
          if (heap === undefined) throw new Error('Chromium heap metric missing')
          samples.push({ open, page: Math.max(...pages), trajectory, first, streamTask, streamWall, input, inputOverlapped, heapMb: heap.value / 1048576, nodes: await page.locator('*').count() })
          console.log(JSON.stringify({ benchmark: 'long-session-browser/sample', sample, initialTurns, pages, ...samples.at(-1) }))
          expect(consoleWatch.pageErrors).toEqual([])
          expect(consoleWatch.warnings).toEqual([])
        } catch (error) { failures.push(error) } finally {
          await browser.close().catch((error: unknown) => failures.push(error))
        }
      } catch (error) { failures.push(error) } finally {
        await scaffold.close().catch((error: unknown) => failures.push(error))
      }
    } catch (error) { failures.push(error) } finally {
      await rm(root, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    if (failures.length > 0) throw new AggregateError(failures, 'browser benchmark failed')
  }
  const aggregate = Object.fromEntries(Object.keys(REFERENCE).map(key => [key, median(samples.map(sample => sample[key as keyof typeof REFERENCE]))]))
  const budgets = Object.fromEntries(Object.entries(REFERENCE).map(([key, value]) => [key, ciTimeBudget(value) + (key === 'streamWall' ? REPLAY_DURATION_MS : 0)]))
  console.log(JSON.stringify({ benchmark: 'long-session-browser/median', turns: HISTORY_TURNS, deltas: DELTAS, paceMs: PACE_MS, samples, aggregate, referenceMs: REFERENCE, budgets }))
  for (const [key, value] of Object.entries(aggregate)) expect.soft(value, key).toBeLessThanOrEqual(budgets[key]!)
})
