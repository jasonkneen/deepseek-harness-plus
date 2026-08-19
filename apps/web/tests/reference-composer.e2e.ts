// Web e2e scenario: the shipped composition discovers local files and cold
// sessions through the real Host, groups both domains in the shared @ menu,
// and projects each pick back into the composer without issuing a model call.
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/reference-composer', import.meta.url))
const MENU_EXPECTED = join(SNAPSHOT_DIR, 'menu.expected.md')
const MODE = webSnapshotMode()
const SOURCE_SESSION_ID = 'reference-source-session'

/** Build one closed source session with a stable title for reference discovery. */
function sourceSessionFixture(): string {
  const session = Session.create(SessionId(SOURCE_SESSION_ID))
  session.append('turn/start', {
    turn: 1,
  })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Research context for the reference menu.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Research notes',
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: 0,
      cwd: '{{cwd}}',
    }),
    ...session.events.map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

describe.skipIf(MODE === 'record')('web e2e: file and session references through the real host', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, sourceSessionFixture(), SOURCE_SESSION_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await writeFile(join(scaffold.workspaceCwd, 'workspace', 'reference.txt'), 'reference fixture\n')
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('groups both sources and projects file text plus an atomic session chip', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-composer'))
    const input = page.locator('textarea').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })

    await input.fill('@')
    await expect.poll(() => menu.getByRole('option').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    const snapshot = await captureStableAria(page, '[role="listbox"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MENU_EXPECTED, snapshot, MODE)
    expect(snapshot).toContain('Files & folders')
    expect(snapshot).toContain('Session conversations')
    expect(snapshot).toContain('File \u00b7 reference.txt')
    expect(snapshot).toContain('Session \u00b7 Research notes')
    expect(snapshot).not.toContain('text: Subagents')

    await input.fill('@reference')
    await menu.getByRole('option', { name: /File \u00b7 reference\.txt/ }).click()
    await expect.poll(() => input.inputValue()).toBe('@reference.txt ')

    await input.fill('@Research')
    await menu.getByRole('option', { name: /Session \u00b7 Research notes/ }).click()
    await expect.poll(() => page.locator('[data-decoration="chip"]').textContent()).toBe('@Research notes')

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['menu.expected.md'])
  })
})
