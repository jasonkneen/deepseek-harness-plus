/**
 * Preview acceptance: the browser-only worker deployment boots the real Cordis
 * tree out of the packed VFS image and reaches an interactive page.
 *
 * `dist/preview.html` is the served page plus one bootstrap script tag, so this
 * run exercises the shipped startup chain: the worker mounts the image,
 * activates the tree, and answers the page's tunnel until the client settles.
 * Two milestones prove that happened — the host's `tree active` boot line,
 * whose lowering contract must be the one this checkout's packer emits, and the
 * workspace hero, which paints only after the client tree comes up over the
 * tunnel.
 *
 * The site is served the way a static host serves it: bytes from `dist/` with
 * no rewrite rules, so a missing file is a 404 rather than the index page.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { expect, it } from 'vitest'
import {
  composeProfile, configTrees, indexWorkspacePackages, packVfsImage, WRAPPER_CONTRACT,
} from '@deepseek-ai/dsh-experimental-webworker-packer'
import { IMAGE_FILE_NAME } from '@deepseek-ai/dsh-experimental-webworker-runtime'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

/** Where the client looks for the image: the runtime's own name, beside the page. */
const IMAGE_FILE = join(DIST_ROOT, 'preview', IMAGE_FILE_NAME)

/** Profile the preview deployment composes; `build:preview` packs the same one. */
const PROFILE = 'web'

/** Pages the preview needs; the Vite build emits both. */
const PAGES = ['index.html', 'preview.html']

/**
 * Content types the preview loads. Anything else is served as opaque bytes.
 *
 * The image goes out as `application/gzip` with no `content-encoding`: the
 * worker inflates the gzip member itself, so a transport-decoded body would
 * leave its `DecompressionStream('gzip')` with plain tar bytes to inflate.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.gz': 'application/gzip',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}

/** Boot line the worker host writes once its tree finished activating. */
const TREE_ACTIVE = 'webworker host: tree active'

/** Image fetch, mount, and tree activation on a loaded machine. */
const BOOT_TIMEOUT_MS = 240_000

/** Client tree settle after the tunnel starts answering. */
const HERO_TIMEOUT_MS = 240_000

/** One served origin over `dist/`. */
interface Site {
  readonly origin: string
  /** Release the port; call after the browser is gone. */
  close(): Promise<void>
}

/**
 * Fail before the browser opens a page the build never produced.
 * @throws When either preview page is missing from `dist/`.
 */
function requirePreviewPages(): void {
  for (const page of PAGES) {
    if (existsSync(join(DIST_ROOT, page))) continue
    throw new Error(`preview boot needs apps/web/dist/${page} — run \`pnpm run build\` from the repository root`)
  }
}

/**
 * The image file to serve, packed here when `dist/` carries none: `pnpm run
 * build` emits the pages but only `build:preview` packs, so this lane packs
 * for itself rather than skipping the deployment it is here to accept. An
 * image already in place is used as it stands — the worker refuses one lowered
 * against another wrapper contract, and that refusal names the rebuild. A
 * self-packed image lands in a temp directory, never in `dist/`: the
 * client-artifact digest record treats `dist/` as build-owned, so a test write
 * there fails the record check for every later consumer.
 * @returns The file to answer `preview/<image>` with, and its teardown.
 * @throws When the closure leaves dependencies unresolved, which would pack an
 * incomplete image the tree fails on later and further from the cause.
 */
function requireVfsImage(): { path: string; cleanup(): void } {
  if (existsSync(IMAGE_FILE)) return { path: IMAGE_FILE, cleanup: () => {} }
  const packed = packVfsImage({
    config: composeProfile(REPO_ROOT, PROFILE),
    profile: PROFILE,
    workspaces: indexWorkspacePackages(REPO_ROOT),
    resolveFrom: REPO_ROOT,
    configTrees: configTrees(REPO_ROOT),
  })
  if (packed.missing.length > 0) {
    throw new Error(`preview boot: ${String(packed.missing.length)} dependencies did not resolve: ${packed.missing.join(', ')}`)
  }
  const directory = mkdtempSync(join(tmpdir(), 'dsh-preview-boot-'))
  const path = join(directory, IMAGE_FILE_NAME)
  writeFileSync(path, packed.image)
  return { path, cleanup: () => { rmSync(directory, { recursive: true, force: true }) } }
}

/**
 * Answer one request with the file it names under `dist/`; the image path
 * answers from wherever {@link requireVfsImage} put the file.
 * @param request - Incoming request; only its path is read.
 * @param response - Response to write the bytes or the 404 to.
 * @param imagePath - File behind `preview/<image>`.
 */
async function respond(request: IncomingMessage, response: ServerResponse, imagePath: string): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const relative = normalize(decodeURIComponent(path)).replace(/^\/+/, '')
  try {
    const body = await readFile(relative === `preview/${IMAGE_FILE_NAME}` ? imagePath : join(DIST_ROOT, relative))
    response.writeHead(200, { 'content-type': MIME[extname(relative)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    // A miss is a miss: the deployment has no SPA fallback, and hiding one
    // behind the index page would make a broken asset URL look like a boot
    // failure.
    response.writeHead(404)
    response.end(`not found: ${relative}`)
  }
}

/**
 * Serve `dist/` over loopback with static-host semantics.
 * @param imagePath - File behind `preview/<image>`.
 * @returns The origin to navigate, and its teardown.
 */
async function serveDist(imagePath: string): Promise<Site> {
  const server = createServer((request, response) => { void respond(request, response, imagePath) })
  await new Promise<void>((listening) => { server.listen(0, '127.0.0.1', listening) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('preview boot: the static server bound no port')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((closed, reject) => {
        server.close((error) => {
          if (error === undefined) closed()
          else reject(error)
        })
      })
    },
  }
}

/**
 * Bound one boot milestone so a stall names the milestone instead of surfacing
 * as the lane's generic test timeout.
 * @param work - The milestone to wait for.
 * @param ms - How long it may take.
 * @param stalled - Error message when it does not arrive in time.
 * @returns What `work` resolved to.
 */
async function within<T>(work: Promise<T>, ms: number, stalled: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(stalled)) }, ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

it('boots the packed worker deployment to an interactive page', async () => {
  requirePreviewPages()
  const image = requireVfsImage()
  try {
    const site = await serveDist(image.path)
    try {
      const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
      try {
        await bootPreview(site.origin, browser)
      } finally {
        await browser.close()
      }
    } finally {
      await site.close()
    }
  } finally {
    image.cleanup()
  }
}, 600_000)

/**
 * Open the preview page and hold it to both boot milestones.
 * @param origin - Origin serving `dist/`.
 * @param browser - Browser to open the page in.
 */
async function bootPreview(origin: string, browser: Browser): Promise<void> {
  const page = await newEnglishPage(browser)
  const pageErrors: Error[] = []
  page.on('pageerror', (error) => { pageErrors.push(error) })
  // Registered before navigation: the worker reports its tree long before the
  // tunnel serves the client, so a listener added later would miss the line.
  const treeActive = new Promise<string>((reported) => {
    page.on('console', (message) => {
      const text = message.text()
      if (text.includes(TREE_ACTIVE)) reported(text)
    })
  })
  try {
    await page.goto(`${origin}/preview.html`, { waitUntil: 'domcontentloaded' })
    const bootLine = await within(treeActive, BOOT_TIMEOUT_MS, `preview boot: the worker never reported "${TREE_ACTIVE}"`)
    // The activated tree ran bodies lowered against the contract this
    // checkout's packer emits; a dist built before a contract change would
    // report the older one.
    expect(bootLine).toContain(`image lowering=${WRAPPER_CONTRACT}`)
    // The hero's workspace picker is the client tree's first interactive
    // surface, so it appears only once the startup chain completed over the
    // tunnel.
    await page.getByRole('textbox', { name: 'Choose workspace' }).waitFor({ timeout: HERO_TIMEOUT_MS })
    expect(pageErrors.map(error => error.message)).toEqual([])
  } catch (error) {
    await saveFailureShot(page, 'preview-boot')
    throw pageErrors.length === 0
      ? error
      : new AggregateError([error, ...pageErrors], 'preview boot failed, with uncaught page errors')
  }
}
