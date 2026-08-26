/** Private request and result transport shared by native subprocess runners. */

import {
  appendFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { constants as osConstants, tmpdir } from 'node:os'
import { join } from 'node:path'

/** One direct command request consumed exactly once by the runner. */
export interface RunnerRequest {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

/** Spawn-error fields preserved across the runner process boundary. */
export interface SerializedSpawnError {
  name: string
  message: string
  code?: string
  errno?: number
  syscall?: string
  path?: string
  spawnargs?: string[]
}

/** Append-only direct-command facts emitted by the runner. */
export type RunnerEvent =
  | { type: 'started'; pid: number }
  | { type: 'exit'; exitCode: number | null; signal: NodeJS.Signals | null }
  | { type: 'spawn-error'; error: SerializedSpawnError }
  | { type: 'runner-error'; error: SerializedSpawnError }

/** Private per-spawn files; their directory is created with the host default private mkdtemp mode. */
export interface RunnerFiles {
  directory: string
  requestPath: string
  eventsPath: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isSerializedSpawnError(value: unknown): value is SerializedSpawnError {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.message === 'string'
    && isOptionalString(value.code)
    && (value.errno === undefined || typeof value.errno === 'number')
    && isOptionalString(value.syscall)
    && isOptionalString(value.path)
    && (value.spawnargs === undefined
      || (Array.isArray(value.spawnargs) && value.spawnargs.every(item => typeof item === 'string')))
}

function parseRunnerEvent(line: string): RunnerEvent {
  const event: unknown = JSON.parse(line)
  if (!isRecord(event)) throw new Error(`subprocess runner emitted invalid event: ${line}`)
  if (event.type === 'started') {
    if (typeof event.pid !== 'number' || !Number.isSafeInteger(event.pid) || event.pid <= 0) {
      throw new Error(`subprocess runner emitted invalid event: ${line}`)
    }
    return { type: 'started', pid: event.pid }
  }
  if (event.type === 'exit') {
    const validExitCode = event.exitCode === null
      || (typeof event.exitCode === 'number' && Number.isSafeInteger(event.exitCode) && event.exitCode >= 0)
    const validSignal = event.signal === null
      || (typeof event.signal === 'string' && Object.hasOwn(osConstants.signals, event.signal))
    if (!validExitCode || !validSignal) throw new Error(`subprocess runner emitted invalid event: ${line}`)
    return {
      type: 'exit',
      exitCode: event.exitCode as number | null,
      signal: event.signal as NodeJS.Signals | null,
    }
  }
  if (event.type === 'spawn-error' || event.type === 'runner-error') {
    if (!isSerializedSpawnError(event.error)) throw new Error(`subprocess runner emitted invalid event: ${line}`)
    return { type: event.type, error: event.error }
  }
  throw new Error(`subprocess runner emitted unknown event: ${line}`)
}

/**
 * Materialize one private runner request.
 * @param request - exact target argv, cwd, and environment.
 * @returns request and event paths owned by this spawn.
 */
export function createRunnerFiles(request: RunnerRequest): RunnerFiles {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-subprocess-runner-'))
  const requestPath = join(directory, 'request.json')
  const eventsPath = join(directory, 'events.ndjson')
  writeFileSync(requestPath, JSON.stringify(request), { flag: 'wx', mode: 0o600 })
  return { directory, requestPath, eventsPath }
}

/**
 * Read and remove the single-use request before target execution.
 * @param requestPath - private request file.
 * @returns parsed runner request.
 */
export function consumeRunnerRequest(requestPath: string): RunnerRequest {
  const parsed: unknown = JSON.parse(readFileSync(requestPath, 'utf8'))
  unlinkSync(requestPath)
  if (!isRecord(parsed) || !Array.isArray(parsed.argv) || parsed.argv.length === 0
    || !parsed.argv.every(value => typeof value === 'string')) {
    throw new Error('subprocess runner request has no executable')
  }
  if (typeof parsed.cwd !== 'string' || !isRecord(parsed.env)
    || !Object.values(parsed.env).every(value => typeof value === 'string')) {
    throw new Error('subprocess runner request has invalid cwd or environment')
  }
  return {
    argv: parsed.argv,
    cwd: parsed.cwd,
    env: parsed.env as Record<string, string>,
  }
}

/**
 * Append one complete event record.
 * @param eventsPath - private append-only event file.
 * @param event - direct-command fact.
 */
export function appendRunnerEvent(eventsPath: string, event: RunnerEvent): void {
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 })
}

/** Parse complete newline-terminated runner records. */
function parseRunnerEvents(content: string): RunnerEvent[] {
  const lines = content.split('\n')
  if (lines.at(-1) !== '') lines.pop()
  return lines.filter(line => line.length > 0).map(parseRunnerEvent)
}

/**
 * Asynchronously parse every complete event record currently present.
 * @param eventsPath - private event file.
 * @returns complete records in append order.
 */
export async function readRunnerEventsAsync(eventsPath: string): Promise<RunnerEvent[]> {
  let content: string
  try {
    content = await readFile(eventsPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return parseRunnerEvents(content)
}

/**
 * Convert an unknown failure into stable cross-process error fields.
 * @param error - failure raised by target or runner launch.
 * @returns serializable Node-shaped fields.
 */
export function serializeSpawnError(error: unknown): SerializedSpawnError {
  const source = error instanceof Error ? error : new Error(String(error))
  const node = source as NodeJS.ErrnoException & { path?: string; spawnargs?: string[] }
  return {
    name: source.name,
    message: source.message,
    ...typeof node.code === 'string' ? { code: node.code } : {},
    ...typeof node.errno === 'number' ? { errno: node.errno } : {},
    ...typeof node.syscall === 'string' ? { syscall: node.syscall } : {},
    ...typeof node.path === 'string' ? { path: node.path } : {},
    ...Array.isArray(node.spawnargs) ? { spawnargs: [...node.spawnargs] } : {},
  }
}

/**
 * Reconstruct one Node-shaped spawn error for the public done rejection.
 * @param serialized - fields received from the runner.
 * @returns error with Node spawn properties restored.
 */
export function deserializeSpawnError(serialized: SerializedSpawnError): Error {
  const error = new Error(serialized.message)
  error.name = serialized.name
  return Object.assign(error, {
    ...serialized.code === undefined ? {} : { code: serialized.code },
    ...serialized.errno === undefined ? {} : { errno: serialized.errno },
    ...serialized.syscall === undefined ? {} : { syscall: serialized.syscall },
    ...serialized.path === undefined ? {} : { path: serialized.path },
    ...serialized.spawnargs === undefined ? {} : { spawnargs: serialized.spawnargs },
  })
}

/**
 * Remove only the private directory created for this spawn.
 * @param files - private paths returned by createRunnerFiles.
 */
export function cleanupRunnerFiles(files: RunnerFiles): void {
  try {
    if (lstatSync(files.directory).isSymbolicLink()) {
      unlinkSync(files.directory)
      return
    }
    for (const file of [files.requestPath, files.eventsPath]) {
      try {
        unlinkSync(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    rmdirSync(files.directory)
  } catch {
    // A crash residue remains private and is not reused by later spawns.
  }
}
