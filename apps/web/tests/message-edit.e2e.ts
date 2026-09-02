// Web e2e: same-session user-message Edit replaces the selected turn and
// reruns directly without creating a fork or exposing the old generation.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/message-edit', import.meta.url))
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.jsonl', import.meta.url))
const OVERRIDE = fileURLToPath(new URL('./expected/message-edit/replay.override.json', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const SESSION_ID = 'message-edit-web-e2e'
const ORIGINAL = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'
const EDITED = 'Use the existing context and reply with exactly EDITED_OK.'

describe('web e2e: edit a historical user message in the same Session', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      replayFixture: SEED,
      replayOverride: OVERRIDE,
      compareReplaySession: false,
    })
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SESSION_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('replaces the old generation, reruns, and survives refresh', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-edit'))
    await page.locator('[role="treeitem"]').first().click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.click()
    await page.getByText(ORIGINAL, { exact: true }).waitFor({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Edit message' }).click()
    const editor = page.getByRole('textbox', { name: 'Edit message' })
    await editor.fill(EDITED)
    const settled = scaffold.whenTurnSettled(30_000)
    await editor.press('Enter')
    await settled

    await page.getByText(EDITED, { exact: true }).waitFor({ timeout: 15_000 })
    await page.getByText('EDITED_OK', { exact: true }).waitFor({ timeout: 15_000 })
    expect(await page.getByText(ORIGINAL, { exact: true }).count()).toBe(0)
    expect(await page.getByText('DONE', { exact: true }).count()).toBe(0)
    const live = scaffold.ctx.sessions.get(SessionId(SESSION_ID))
    const replacement = live?.snapshotEvents().findLast((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message' && event.conversationOp !== undefined)
    expect(replacement).toMatchObject({
      data: { content: [{ type: 'text', text: EDITED }] },
      surfaceOp: { op: 'replace' },
      conversationOp: { op: 'replace' },
    })

    await page.reload({ waitUntil: 'load' })
    await page.getByText(EDITED, { exact: true }).waitFor({ timeout: 15_000 })
    await page.getByText('EDITED_OK', { exact: true }).waitFor({ timeout: 15_000 })
    expect(await page.getByText(ORIGINAL, { exact: true }).count()).toBe(0)
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)

  it.skipIf(MODE === 'record')('keeps the expected artifact inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
