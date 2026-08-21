/**
 * dsh desktop shell: embeds the harness Web UI in an Electron window with a
 * hidden title bar that keeps the native macOS traffic lights, plus opt-in
 * macOS glass effects.
 *
 * The renderer is the harness Web UI served by `dsh web`, never code from this
 * package: the window loads a loopback URL, so no preload, node integration,
 * or bundled assets are involved. When no server already answers on the
 * configured port, the `dsh` CLI is spawned as a child process (`dsh web
 * --no-open --port <port>`) and killed together with its process group on
 * quit. All behavior is configurable through DSH_DESKTOP_* environment
 * variables documented in README.md; defaults assume a loopback server on
 * port 3080.
 */

import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  shell,
  type BrowserWindowConstructorOptions,
} from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Default `dsh web` listen port. */
const DEFAULT_PORT = 3080

/** The npm package that provides the `dsh` server CLI. */
const DSH_PACKAGE = '@deepseek-ai/dsh'

/** Glass effect modes selectable with DSH_DESKTOP_GLASS. */
type GlassMode = 'off' | 'basic' | 'liquid'

const isMac = process.platform === 'darwin'
const port = parsePort(process.env.DSH_DESKTOP_PORT)
const appUrl = process.env.DSH_DESKTOP_URL ?? `http://127.0.0.1:${port}`
const glass = parseGlass(process.env.DSH_DESKTOP_GLASS)

let server: ChildProcess | undefined
let quitting = false

/** Height (px) of the sidebar gutter kept clear for the macOS traffic lights. */
const TRAFFIC_LANE_HEIGHT = 40

/** Resolve DSH_DESKTOP_PORT to a valid port number, defaulting to DEFAULT_PORT. */
function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : DEFAULT_PORT
}

/** Resolve DSH_DESKTOP_GLASS to a known mode, falling back to `off`. */
function parseGlass(raw: string | undefined): GlassMode {
  return raw === 'basic' || raw === 'liquid' ? raw : 'off'
}

/** Whether a server already answers on `port`; any HTTP response counts as up. */
async function serverUp(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

/** Common Node/npm install dirs. A GUI app launched from a DMG gets a minimal
 *  launchd PATH that omits nvm/homebrew, so PATH scanning alone misses `dsh`. */
function candidateBinDirs(): string[] {
  const dirs: string[] = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  const nvmRoot = join(homedir(), '.nvm', 'versions', 'node')
  try {
    for (const version of readdirSync(nvmRoot)) dirs.push(join(nvmRoot, version, 'bin'))
  } catch {
    /* no nvm install */
  }
  return dirs
}

/** Resolve `cmd` to an executable path, searching PATH then common bins. */
function findExecutable(cmd: string): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const tryDirs = (dirs: Iterable<string>): string | undefined => {
    for (const dir of dirs) {
      if (dir === '') continue
      for (const ext of exts) {
        const candidate = join(dir, `${cmd}${ext}`)
        try {
          accessSync(candidate, constants.X_OK)
          return candidate
        } catch {
          /* keep searching */
        }
      }
    }
    return undefined
  }
  return tryDirs((process.env.PATH ?? '').split(delimiter)) ?? tryDirs(candidateBinDirs())
}

/** Resolve `dsh` next to the npm binary (npm's global bin dir), if installed. */
function globalBinDsh(): string | undefined {
  const npm = findExecutable('npm')
  if (npm === undefined) return undefined
  const dsh = join(dirname(npm), process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  try {
    accessSync(dsh, constants.X_OK)
    return dsh
  } catch {
    return undefined
  }
}

/** Show a fatal error and quit; the explicit `quitting` flag skips the server-exit dialog. */
function showFatal(message: string): void {
  dialog.showErrorBox('DeepSeek Harness', message)
  quitting = true
  app.quit()
}

/** Spawn the harness server child; its exit or launch failure quits the app. */
function startServer(command: string): void {
  const extraArgs = (process.env.DSH_DESKTOP_SERVER_ARGS ?? '')
    .split(/\s+/)
    .filter(part => part !== '')
  // For a resolved absolute binary, put its dir first on PATH so the spawned
  // `dsh` can find its own `node`/`npm` under a minimal launchd PATH.
  const env = { ...process.env }
  if (isAbsolute(command)) {
    const binDir = dirname(command)
    if (env.PATH === undefined || !env.PATH.split(delimiter).includes(binDir)) {
      env.PATH = `${binDir}${delimiter}${env.PATH ?? ''}`
    }
  }
  server = spawn(command, [...extraArgs, 'web', '--no-open', '--port', String(port)], {
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    cwd: process.env.DSH_DESKTOP_CWD ?? homedir(),
    env,
  })
  server.once('error', (error) => {
    server = undefined
    if (!quitting) {
      dialog.showErrorBox('DeepSeek Harness', `Failed to launch the server command: ${error.message}`)
      app.quit()
    }
  })
  server.once('exit', () => {
    server = undefined
    if (!quitting) {
      dialog.showErrorBox(
        'DeepSeek Harness',
        'The dsh server exited before the window could be served. Start it yourself with `dsh web --no-open` or set DSH_DESKTOP_SERVER_CMD.',
      )
      app.quit()
    }
  })
}

/** Wait for the spawned server to answer, with a bounded deadline. */
async function waitForServer(): Promise<boolean> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await serverUp()) return true
    await delay(250)
  }
  return false
}

/** The dsh npm package to install (overridable for a fork's published CLI). */
function installPackage(): string {
  return process.env.DSH_DESKTOP_PACKAGE ?? DSH_PACKAGE
}

/** Run `npm install -g <pkg>` via the resolved npm binary; resolves true on success. */
function runInstall(npm: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(npm, ['install', '-g', installPackage()], {
      stdio: 'inherit',
      env: process.env,
      cwd: homedir(),
    })
    child.once('error', (error) => {
      console.error('dsh-desktop: npm install failed', error)
      resolve(false)
    })
    child.once('exit', (code) => { resolve(code === 0) })
  })
}

/** Ask permission to install `dsh`, then install and start it; quit on decline. */
async function ensureServerInstalled(serverCommand: string): Promise<void> {
  if (serverCommand !== 'dsh') {
    showFatal(
      `The server command '${serverCommand}' is not on PATH, and there is no managed install for it. ` +
        'Start a server and set DSH_DESKTOP_URL, or install a command that serves the Web UI.',
    )
    return
  }
  const choice = await dialog.showMessageBox({
    type: 'question',
    message: 'The dsh CLI is not installed.',
    detail: 'DeepSeek Harness serves its UI with the dsh CLI (the `dsh web` command). Install it globally via npm now?',
    buttons: ['Install dsh', 'Install later', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (choice.response !== 0) {
    showFatal(
      'Open a terminal and run `npm install -g @deepseek-ai/dsh` (or start `dsh web --no-open`), then relaunch. ' +
        'Or set DSH_DESKTOP_URL to an already-running server.',
    )
    return
  }
  const npm = findExecutable('npm')
  if (npm === undefined) {
    showFatal('npm was not found. Install Node.js (which bundles npm), then run `npm install -g @deepseek-ai/dsh` and relaunch.')
    return
  }
  const ok = await runInstall(npm)
  if (!ok) {
    showFatal(`The dsh install failed (npm exited with an error). Open a terminal, run \`npm install -g ${installPackage()}\` manually, then relaunch.`)
    return
  }
  const resolved = findExecutable(serverCommand) ?? globalBinDsh()
  if (resolved === undefined) {
    showFatal(`The install finished, but \`dsh\` was not found. Open a new shell, run \`npm install -g ${installPackage()}\`, then relaunch.`)
    return
  }
  startServer(resolved)
  if (server !== undefined && await waitForServer()) return
  showFatal(`The dsh server was installed but did not answer on http://127.0.0.1:${port} within 60s.`)
}

/** Download + cache a fork-provided self-contained dsh server binary (a pkg exe,
 *  so no Electron-ABI/native-module concerns). URL is a base like
 *  https://<host>/dsh-server that serves `<platform>-<arch>` per file. */
async function ensureDownloadedServer(): Promise<string | undefined> {
  const base = process.env.DSH_DESKTOP_DOWNLOAD_URL
  if (base === undefined) return undefined
  const platform = process.platform === 'darwin' ? 'darwin' : 'win32'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const fileName = `dsh-server-${platform}-${arch}`
  const target = join(homedir(), '.dsh-desktop', 'server', fileName)
  try {
    if (!existsSync(target)) {
      const url = `${base.replace(/\/+$/, '')}/${fileName}`
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, Buffer.from(await response.arrayBuffer()))
      chmodSync(target, 0o755)
    }
    return target
  } catch (error) {
    console.error('dsh-desktop: server download failed', error)
    return undefined
  }
}

/** Pick the server mode: external URL, a running instance, a PATH CLI, a download, or install. */
async function resolveServer(): Promise<void> {
  if (process.env.DSH_DESKTOP_URL !== undefined) return
  if (await serverUp()) return
  const serverCommand = process.env.DSH_DESKTOP_SERVER_CMD ?? 'dsh'
  const resolved = findExecutable(serverCommand)
  if (resolved !== undefined) {
    startServer(resolved)
    if (server !== undefined && await waitForServer()) return
    showFatal(`The '${serverCommand}' server did not answer on http://127.0.0.1:${port} within 60s.`)
    return
  }
  const downloaded = await ensureDownloadedServer()
  if (downloaded !== undefined) {
    startServer(downloaded)
    if (server !== undefined && await waitForServer()) return
    showFatal(`The downloaded server did not answer on http://127.0.0.1:${port} within 60s.`)
    return
  }
  await ensureServerInstalled(serverCommand)
}

/** Window chrome for frameless mode: native traffic lights on macOS, WCO elsewhere. */
function chromeOptions(): Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'trafficLightPosition' | 'titleBarOverlay'
> {
  if (isMac) {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 } }
  }
  const symbolColor = nativeTheme.shouldUseDarkColors ? '#ffffff' : '#000000'
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor, height: 40 },
  }
}

/** Renderer CSS injected by the wrapper: macOS traffic-light gutter plus glass. */
function shellCss(): string {
  // The sidebar column already fills the window height, so its background runs
  // up behind the native traffic lights. Slide the sidebar content down below
  // the lights (the column keeps its full-height background), and make the
  // header row the drag surface with its controls still clickable. Class
  // substrings target the sidebar by its stable local module names; the
  // collapsed rail has its own compact header, so only the expanded row is
  // made draggable.
  const macShell = isMac
    ? `[class*="sidebarCol"] { padding-top: ${TRAFFIC_LANE_HEIGHT}px; box-sizing: border-box; }
[class*="root"]:not([class*="collapsed"]) [class*="logoRow"] { -webkit-app-region: drag; }
[class*="root"]:not([class*="collapsed"]) [class*="logoRow"] button, [class*="root"]:not([class*="collapsed"]) [class*="logoRow"] a { -webkit-app-region: no-drag; }`
    : ''
  const glassCss = glass === 'off' ? '' : 'html, body { background: transparent !important; }'
  return `${macShell}${glassCss}`
}

/** Render the window with hidden chrome, traffic lights, and the chosen glass. */
function createWindow(): BrowserWindow {
  const options: BrowserWindowConstructorOptions = {
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: !isMac,
    ...chromeOptions(),
  }
  if (glass === 'off') {
    options.backgroundColor = '#0b0e14'
  } else {
    options.transparent = true
    if (glass === 'basic') {
      options.vibrancy = 'under-window'
      options.visualEffectState = 'followWindow'
    }
  }

  const win = new BrowserWindow(options)
  win.once('ready-to-show', () => {
    win.show()
  })

  // Keep the renderer a pure web client: open every external http(s) target in
  // the system browser and never navigate the window away from the app origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(appUrl)) return
    event.preventDefault()
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
  })

  // The embedded Web UI is not traffic-light aware, so on macOS reserve a
  // draggable lane at the very top that keeps content clear of the native
  // buttons; in glass modes also let the window material show through where
  // the page does not draw.
  win.webContents.on('dom-ready', () => {
    void win.webContents.insertCSS(shellCss())
  })

  if (glass === 'liquid' && isMac) {
    win.webContents.once('did-finish-load', () => {
      void applyLiquidGlass(win)
    })
  }

  return win
}

/** Apply native macOS 26 liquid glass behind the web content; fall back to vibrancy. */
async function applyLiquidGlass(win: BrowserWindow): Promise<void> {
  win.setWindowButtonVisibility(true)
  try {
    const liquidGlass = await import('electron-liquid-glass')
    const radius = parseGlassRadius(process.env.DSH_DESKTOP_GLASS_RADIUS)
    liquidGlass.default.addView(win.getNativeWindowHandle(), { cornerRadius: radius })
  } catch (error) {
    console.warn('dsh-desktop: liquid glass unavailable, falling back to basic vibrancy', error)
    win.setVibrancy('under-window')
  }
}

/** Resolve DSH_DESKTOP_GLASS_RADIUS to a non-negative pixel radius, defaulting to 16. */
function parseGlassRadius(raw: string | undefined): number {
  if (raw === undefined) return 16
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 16
}

/** Terminate the spawned server and its process group, if any. */
function stopServer(): void {
  if (server === undefined) return
  const child = server
  server = undefined
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    child.kill('SIGTERM')
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win !== undefined) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady()
    .then(async () => {
      app.setAppUserModelId('ai.deepseek.dsh-desktop')
      const win = createWindow()
      await resolveServer()
      if (quitting) return
      await win.loadURL(appUrl)
    })
    .catch((error: unknown) => {
      dialog.showErrorBox(
        'DeepSeek Harness',
        `Failed to start: ${error instanceof Error ? error.message : String(error)}`,
      )
      app.quit()
    })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    stopServer()
  })
}
