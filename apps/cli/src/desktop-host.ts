/**
 * Electron child-process entry: boots the desktop project without a listening
 * socket and carries API plus validated Web assets over Node IPC.
 * @module @deepseek-ai/dsh/desktop-host
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  composeEntries,
  loadLayeredEnv,
  loadProfileDirectory,
  loadOverlayPatches,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type { ConnectionFetchHandler } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-modules'
import { renderIndexInjections, type IndexInjection } from '@deepseek-ai/dsh-host-webserver'

/** IPC protocol version shared with the Electron shell. */
export const DESKTOP_HOST_PROTOCOL_VERSION = 2 as const

/** One request forwarded from Electron's `dsh-app://` handler. */
export interface DesktopHostFetchCommand {
  readonly type: 'fetch'
  readonly id: string
  readonly request: {
    readonly url: string
    readonly method: string
    readonly headers: readonly [string, string][]
    readonly bodyBase64?: string
  }
}

/** Commands accepted by the desktop child process. */
export type DesktopHostCommand = DesktopHostFetchCommand | {
  readonly type: 'cancel'
  readonly id: string
} | {
  readonly type: 'shutdown'
}

/** Events emitted by the desktop child process. */
export type DesktopHostEvent = {
  readonly type: 'ready'
  readonly protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  readonly dshVersion: string
} | {
  readonly type: 'response-start'
  readonly id: string
  readonly status: number
  readonly headers: readonly [string, string][]
} | {
  readonly type: 'response-chunk'
  readonly id: string
  readonly chunkBase64: string
} | {
  readonly type: 'response-end'
  readonly id: string
} | {
  readonly type: 'response-error'
  readonly id: string
  readonly message: string
} | {
  readonly type: 'fatal'
  readonly message: string
}

/** Controller returned to tests and the self-executing process entry. */
export interface DesktopHostController {
  /** Installed dsh version carried by this host. */
  readonly dshVersion: string
  /** Dispatch one custom-protocol request and stream its response to `send`. */
  fetch(command: DesktopHostFetchCommand): Promise<void>
  /** Abort one in-flight request. */
  cancel(id: string): void
  /** Stop accepting messages and await complete host teardown. */
  dispose(): Promise<void>
}

function isCanonicalBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDesktopHostCommand(message: unknown): message is DesktopHostCommand {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  if (candidate.type === 'shutdown') return true
  if (candidate.type === 'cancel') return typeof candidate.id === 'string'
  if (candidate.type !== 'fetch' || typeof candidate.id !== 'string'
    || typeof candidate.request !== 'object' || candidate.request === null) return false
  const request = candidate.request as Record<string, unknown>
  return typeof request.url === 'string' && typeof request.method === 'string'
    && Array.isArray(request.headers)
    && request.headers.every(header => Array.isArray(header) && header.length === 2
      && typeof header[0] === 'string' && typeof header[1] === 'string')
    && (request.bodyBase64 === undefined || isCanonicalBase64(request.bodyBase64))
}

interface PackageManifest {
  readonly name?: string
  readonly version?: string
}

const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))
const DESKTOP_PATCH = fileURLToPath(new URL('../config/desktop.cordis.patch.yml', import.meta.url))
const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))
const ROOT_CONFIG = '# Electron desktop composition root; package transactions own this file.\n[]\n'
const ROOT_CONFIG_FILENAME = 'desktop.cordis.yml'
const DESKTOP_STREAM_PATH = '/.dsh/remote-stream'

const DESKTOP_TRANSPORT_SCRIPT = `globalThis.__DSH_TRANSPORT__={
  ownsHost:true,
  async *openStream(endpoint,payload,signal){
    const response=await fetch(${JSON.stringify(DESKTOP_STREAM_PATH)},{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,payload}),signal
    })
    if(!response.ok||response.body===null)throw new Error('desktop stream transport failed: HTTP '+response.status)
    const reader=response.body.getReader(),decoder=new TextDecoder()
    let pending=''
    for(;;){
      const {done,value}=await reader.read()
      pending+=decoder.decode(value,{stream:!done})
      let newline
      while((newline=pending.indexOf('\\n'))!==-1){
        const line=pending.slice(0,newline);pending=pending.slice(newline+1)
        if(line!=='')yield JSON.parse(line)
      }
      if(done)break
    }
    if(pending!=='')yield JSON.parse(pending)
  }
}`

const MIME: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}

function readManifest(path: string): PackageManifest {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(value)) throw new Error(`dsh desktop: ${path} must contain a package manifest`)
  return {
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
  }
}

function packageManifestPath(projectDir: string, packageName: string): string {
  const path = join(projectDir, 'node_modules', ...packageName.split('/'), 'package.json')
  if (!existsSync(path)) throw new Error(`dsh desktop: installed package ${JSON.stringify(packageName)} has no manifest`)
  return path
}

function isProjectPath(projectDir: string, target: string): boolean {
  const root = realpathSync(projectDir)
  const path = realpathSync(target)
  return path === root || path.startsWith(root + sep)
}

function desktopPatches(projectDir: string, allowLinkedPackages: boolean): PatchOptions[] {
  const profile = loadProfileDirectory('dsh desktop', projectDir, INSTALL_ANCHOR)
  for (const layer of profile.layers) {
    if (!allowLinkedPackages && !isProjectPath(projectDir, layer.packageDir)) {
      throw new Error(`dsh desktop: profile bundle ${JSON.stringify(layer.packageName)} resolved outside the desktop profile`)
    }
  }
  const layers = [
    ...profile.layers.map(layer => layer.patches),
    profile.patches,
    loadOverlayPatches('dsh desktop', DESKTOP_PATCH),
  ]
  const rows = new Map(composeEntries(layers).flatMap(row => typeof row.id === 'string' ? [[row.id, row] as const] : []))
  const agentPresets = rows.get('agent-presets')
  if (agentPresets !== undefined) {
    layers.push([{
      id: 'agent-presets',
      config: {
        ...(agentPresets.config ?? {}) as Record<string, unknown>,
        roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }],
      },
    }])
  }
  return layers.flat()
}

function dshVersion(projectDir: string): string {
  const manifest = readManifest(packageManifestPath(projectDir, '@deepseek-ai/dsh'))
  if (typeof manifest.version !== 'string') throw new Error('dsh desktop: installed dsh manifest has no version')
  return manifest.version
}

function assetHandler(ctx: Context, projectDir: string): ConnectionFetchHandler {
  const require = createRequire(join(projectDir, 'package.json'))
  const distIndex = require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  const distRoot = realpathSync(dirname(distIndex))
  const renderIndex = async (): Promise<Response> => {
    const rows: IndexInjection[] = [{ kind: 'script', placement: 'head', text: DESKTOP_TRANSPORT_SCRIPT }]
    ctx.emit('webserver/index-inject', rows)
    const body = renderIndexInjections(await readFile(distIndex, 'utf8'), rows)
    return new Response(body, { headers: { 'content-type': MIME['.html'] ?? 'text/html; charset=utf-8' } })
  }
  return {
    async fetch(request): Promise<Response> {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
      const url = new URL(request.url)
      if (url.pathname.startsWith('/plugins/')) return ctx.clientModules.fetchBundle(request)
      let pathname: string
      try {
        pathname = decodeURIComponent(url.pathname)
      } catch {
        return new Response(null, { status: 400 })
      }
      if (pathname === '/' || pathname === '/index.html') return renderIndex()
      const target = resolve(normalize(join(distRoot, pathname)))
      if (target !== distRoot && !target.startsWith(distRoot + sep)) return new Response(null, { status: 403 })
      try {
        const realTarget = realpathSync(target)
        if (realTarget !== distRoot && !realTarget.startsWith(distRoot + sep)) return new Response(null, { status: 403 })
        return new Response(request.method === 'HEAD' ? null : await readFile(realTarget), {
          headers: { 'content-type': MIME[extname(realTarget)] ?? 'application/octet-stream' },
        })
      } catch {
        return renderIndex()
      }
    },
  }
}

function remoteStreamHandler(ctx: Context): ConnectionFetchHandler {
  return {
    async fetch(request): Promise<Response> {
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      const gateway = ctx.get('typertGateway')
      if (gateway === undefined) return new Response('gateway unavailable', { status: 503 })
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      if (!isRecord(body) || typeof body.endpoint !== 'string') {
        return new Response('invalid stream request', { status: 400 })
      }
      const abort = new AbortController()
      const cancel = (): void => { abort.abort(request.signal.reason) }
      request.signal.addEventListener('abort', cancel, { once: true })
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const values = await gateway.wireStream.open(body.endpoint as string, body.payload, abort.signal)
            for await (const value of values) {
              controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
            }
            controller.close()
          } catch (error) {
            controller.error(error)
          } finally {
            request.signal.removeEventListener('abort', cancel)
          }
        },
        cancel(reason) {
          abort.abort(reason)
          request.signal.removeEventListener('abort', cancel)
        },
      })
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
    },
  }
}

const DESKTOP_IPC_CHUNK_BYTES = 64 * 1024

/**
 * Boot one installed desktop npm project.
 * @param projectDir - active or staged Electron-owned desktop profile.
 * @param send - IPC event sink; callback exceptions are contained by the caller.
 * @param options - development-only allowance for workspace-linked bundle packages.
 * @returns controller after every Host and client-manifest row is active.
 */
export async function runDesktopHost(
  projectDir: string,
  send: (event: DesktopHostEvent) => void,
  options: { allowLinkedPackages?: boolean } = {},
): Promise<DesktopHostController> {
  const absoluteProject = resolve(projectDir)
  mkdirSync(absoluteProject, { recursive: true })
  const rootConfig = join(absoluteProject, ROOT_CONFIG_FILENAME)
  writeFileSync(rootConfig, ROOT_CONFIG)
  const environment = loadLayeredEnv('dsh desktop')
  let current: Context | undefined
  const ctx = await boot('dsh desktop', rootConfig, structuredClone(desktopPatches(
    absoluteProject,
    options.allowLinkedPackages === true,
  )), (hostCtx) => {
    current = hostCtx
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    provideCmdline(hostCtx, { args: [], exit: () => {} })
  })
  current = ctx
  const connection = ctx.get('connection')
  const clientModules = ctx.get('clientModules')
  const gateway = ctx.get('typertGateway')
  if (connection === undefined || clientModules === undefined || gateway === undefined) {
    await ctx.fiber.dispose()
    throw new Error('dsh desktop: composition did not provide connection, typertGateway, and clientModules')
  }
  const api = connection.createSharedFetchHandler('/api')
  const assets = assetHandler(ctx, absoluteProject)
  const streams = remoteStreamHandler(ctx)
  const requests = new Map<string, AbortController>()
  let disposing: Promise<void> | undefined

  const dispose = async (): Promise<void> => {
    disposing ??= (async () => {
      for (const controller of requests.values()) controller.abort()
      requests.clear()
      await current?.fiber.dispose()
      current = undefined
    })()
    await disposing
  }

  return {
    dshVersion: dshVersion(absoluteProject),
    cancel(id) {
      requests.get(id)?.abort()
    },
    async fetch(command) {
      if (disposing !== undefined) throw new Error('dsh desktop: host is disposing')
      const controller = new AbortController()
      requests.set(command.id, controller)
      try {
        const url = new URL(command.request.url)
        const body = command.request.bodyBase64 === undefined
          ? undefined
          : Buffer.from(command.request.bodyBase64, 'base64')
        const request = new Request(url, {
          method: command.request.method,
          headers: new Headers(command.request.headers.map(([name, value]) => [name, value] as [string, string])),
          ...(body === undefined || body.byteLength === 0 ? {} : { body }),
          signal: controller.signal,
        })
        const response = url.pathname === DESKTOP_STREAM_PATH
          ? await streams.fetch(request)
          : url.pathname.startsWith('/api/')
            ? await api.fetch(request)
            : await assets.fetch(request)
        send({
          type: 'response-start',
          id: command.id,
          status: response.status,
          headers: [...response.headers.entries()],
        })
        if (response.body !== null) {
          for await (const chunk of response.body) {
            const bytes = Buffer.from(chunk)
            for (let offset = 0; offset < bytes.byteLength; offset += DESKTOP_IPC_CHUNK_BYTES) {
              send({
                type: 'response-chunk',
                id: command.id,
                chunkBase64: bytes.subarray(offset, offset + DESKTOP_IPC_CHUNK_BYTES).toString('base64'),
              })
            }
          }
        }
        send({ type: 'response-end', id: command.id })
      } catch (error) {
        if (!controller.signal.aborted) {
          send({
            type: 'response-error',
            id: command.id,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      } finally {
        requests.delete(command.id)
      }
    },
    dispose,
  }
}

async function main(): Promise<void> {
  const projectDir = process.argv[2]
  if (projectDir === undefined || process.send === undefined) {
    throw new Error('dsh desktop: expected project directory and a Node IPC channel')
  }
  const option = process.argv[3]
  if (option !== undefined && option !== '--allow-linked-profile') {
    throw new Error(`dsh desktop: unsupported internal option ${JSON.stringify(option)}`)
  }
  const send = (event: DesktopHostEvent): void => {
    if (process.send === undefined || !process.connected) return
    try {
      process.send(event)
    } catch (error) {
      // A concurrent parent disconnect owns teardown; only that closed-channel
      // condition is safe to discard while streamed responses unwind.
      if ((error as NodeJS.ErrnoException).code !== 'ERR_IPC_CHANNEL_CLOSED') throw error
    }
  }
  const controller = await runDesktopHost(projectDir, send, { allowLinkedPackages: option !== undefined })
  send({
    type: 'ready',
    protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    dshVersion: controller.dshVersion,
  })
  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await controller.dispose()
    if (process.connected) process.disconnect()
    process.exitCode = 0
  }
  process.on('message', (message: unknown) => {
    if (!isDesktopHostCommand(message)) {
      send({ type: 'fatal', message: 'dsh desktop: invalid Electron IPC command' })
      void stop()
      return
    }
    switch (message.type) {
      case 'fetch':
        void controller.fetch(message)
        return
      case 'cancel':
        controller.cancel(message.id)
        return
      case 'shutdown':
        void stop()
        return
      default:
        message satisfies never
    }
  })
  process.once('disconnect', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
  process.once('SIGINT', () => { void stop() })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (process.send !== undefined) process.send({ type: 'fatal', message } satisfies DesktopHostEvent)
    else process.stderr.write(`dsh desktop: ${message}\n`)
    process.exitCode = 1
  })
}
