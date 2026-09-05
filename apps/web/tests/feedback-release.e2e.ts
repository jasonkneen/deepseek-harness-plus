// The shipped disabled OTel row keeps feedback local. A loopback collector
// observes the complete browser session through scaffold shutdown, while a
// separate persistence reader verifies both remarks reach the session log.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { gunzipSync } from 'node:zlib'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureExpandedTurnProcessAria, captureStableAria,
  compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, readPersistedEvents, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/feedback-release', import.meta.url))
// The local-only path needs only a settled ordinary turn, so this lane replays
// the feedback-command scenario's recorded session (declared as this
// manifest's `session.source`) instead of recording a duplicate.
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/feedback-command/session.v2.jsonl', import.meta.url))
const ACK_EXPECTED = join(SNAPSHOT_DIR, 'ack.expected.md')
const ACK_EXPANDED_EXPECTED = join(SNAPSHOT_DIR, 'ack-expanded.expected.md')
const MODE = webSnapshotMode()

const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'

describe('web e2e: feedback stays local with shipped OTel disabled', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let collector: Server
  let sessionId: SessionId
  const uploads: string[] = []

  beforeAll(async () => {
    collector = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const raw = Buffer.concat(chunks)
        uploads.push((request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString())
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      })
    })
    collector.listen(0, '127.0.0.1')
    await once(collector, 'listening')
    const address = collector.address()
    if (address === null || typeof address === 'string') throw new Error('collector has no port')
    scaffold = await launchWebScaffold({
      telemetryUrl: `http://127.0.0.1:${address.port}/v1/logs`,
      // The replayed session.v2.jsonl belongs to the feedback-command scenario;
      // comparing (or refreshing) the persisted session here would rewrite
      // that shared source with this lane's feedback events. Persistence and
      // collector assertions belong to this lane.
      compareReplaySession: false,
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 5 }),
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
      await scaffold?.close()
      expect(uploads).toEqual([])
    } finally {
      if (collector?.listening) {
        await new Promise<void>((resolve, reject) => {
          collector.close((error) => {
            if (error) reject(error)
            else resolve()
          })
          collector.closeAllConnections()
        })
      }
    }
  })

  it('drives the recorded prompt to a settled turn (all modes)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-feedback-release-drive'))
    if (MODE !== 'record') {
      // Drift guard: the shared fixture must carry exactly the drive prompt.
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    sessionId = await settled
  }, 60_000)

  it.skipIf(MODE === 'record')('records feedback locally and acknowledges its session and anonymous user ids', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-feedback-release'))
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    expect(uploads).toEqual([])
    const input = page.locator('[data-composer-input]').first()
    await input.fill('/feedback the diff view is unreadable')
    await input.press('Enter')

    await page.getByText(/Feedback recorded for session/).waitFor({ timeout: 10_000 })
    expect(await page.getByText(/Anonymous user: [0-9a-f-]+\.$/i).count()).toBe(1)
    expect(uploads).toEqual([])

    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(ACK_EXPECTED, snapshot, MODE)
    const expanded = await captureExpandedTurnProcessAria(
      page,
      '[class*="centerCol"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(ACK_EXPANDED_EXPECTED, expanded, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('persists both feedback remarks without uploading session records', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-feedback-release-suffix'))
    const input = page.locator('[data-composer-input]').first()
    await input.fill('/feedback the second remark')
    await input.press('Enter')
    await expect.poll(() => page.getByText(/Feedback recorded for session/).count()).toBe(2)
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('feedback session has no active agent')
    await scaffold.ctx.sessions.flush(agent.session)
    const events = await readPersistedEvents(scaffold, sessionId)
    expect(events.filter(event => event.type === 'feedback/record')).toMatchObject([
      { data: { text: 'the diff view is unreadable' } },
      { data: { text: 'the second remark' } },
    ])
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)
    expect(uploads).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ack.expected.md', 'ack-expanded.expected.md'])
  })
})
