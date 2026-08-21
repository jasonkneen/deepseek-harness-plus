/** Parent-side launch and direct-result transport for native runners. */

import type { ChildProcess, StdioOptions } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleepMs } from 'node:timers/promises'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  cleanupRunnerFiles,
  createRunnerFiles,
  deserializeSpawnError,
  readRunnerEvents,
  readRunnerEventsAsync,
} from './runner-protocol.ts'
import type { RunnerEvent, RunnerFiles, RunnerRequest } from './runner-protocol.ts'
import { childEnv } from './spawn.ts'

const handshakeWait = new Int32Array(new SharedArrayBuffer(4))
const RUNNER_HANDSHAKE_TIMEOUT_MS = 10_000
const RUNNER_EVENT_POLL_MS = 100
const PACKAGED_RUNNER_ARG = '--dsh-internal-subprocess-runner'

/**
 * Resolve the runner entry from the current module's source or built plane.
 * @returns Node executable and runner argv prefix.
 */
export function spawnRunnerInvocation(): string[] {
  if ('pkg' in process) return [process.execPath, PACKAGED_RUNNER_ARG]
  /* v8 ignore start -- source-plane coverage cannot execute the bundled module;
     the required built-runner smoke executes its published entry. */
  if (extname(fileURLToPath(import.meta.url)) !== '.ts') {
    const builtEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/spawn-runner'))
    return [process.execPath, builtEntry]
  }
  /* v8 ignore stop */
  const sourceEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/src/spawn-runner.ts'))
  return [process.execPath, '--import', 'tsx/esm', sourceEntry]
}

/**
 * Build wrapper stdio corresponding to the public target dispositions.
 * @param spec - target stdio request.
 * @param ipc - append a private control channel for the Windows launcher.
 * @returns child-process stdio configuration.
 */
export function runnerStdio(spec: SubprocessSpawnSpec, ipc = false): StdioOptions {
  const stdio: StdioOptions = [
    spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe',
    spec.stdio.stdout === 'inherit' ? 'inherit' : 'pipe',
    spec.stdio.stderr === 'inherit' ? 'inherit' : 'pipe',
  ]
  if (ipc) stdio.push('ipc')
  return stdio
}

/**
 * Materialize the exact target request without undefined environment tombstones.
 * @param spec - target argv, cwd, and explicit environment.
 * @returns private request and event paths.
 */
export function runnerFiles(spec: SubprocessSpawnSpec): RunnerFiles {
  const env = Object.fromEntries(
    Object.entries(childEnv(spec.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const request: RunnerRequest = { argv: [...spec.argv], cwd: spec.cwd, env }
  return createRunnerFiles(request)
}

interface RunnerHandshake {
  pid: number
  events: RunnerEvent[]
}

/** Observe wrapper death without waiting for Node's blocked event loop to emit close. */
function runnerExited(child: ChildProcess, pid: number): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return true
  /* v8 ignore start -- Linux zombie detection is exercised by the real user-systemd test environment. */
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
      const suffix = stat.slice(stat.lastIndexOf(')') + 2)
      if (suffix.startsWith('Z') || suffix.startsWith('X')) return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    }
  }
  /* v8 ignore stop */
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    /* v8 ignore next -- EPERM means the known process still exists but is not signalable. */
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** Wait synchronously only until the runner reports target start or spawn failure. */
function waitForRunnerHandshake(child: ChildProcess, files: RunnerFiles): RunnerHandshake {
  const deadline = Date.now() + RUNNER_HANDSHAKE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const events = readRunnerEvents(files.eventsPath)
    const terminal = events.find(event => event.type === 'started' || event.type === 'spawn-error' || event.type === 'runner-error')
    if (terminal?.type === 'started') return { pid: terminal.pid, events }
    if (terminal?.type === 'spawn-error' || terminal?.type === 'runner-error') return { pid: -1, events }
    if (child.pid === undefined) throw new Error('native subprocess runner failed to start')
    if (runnerExited(child, child.pid)) throw new Error('native subprocess runner exited before reporting target start')
    Atomics.wait(handshakeWait, 0, 0, 5)
  }
  throw new Error(`native subprocess runner did not report target start within ${String(RUNNER_HANDSHAKE_TIMEOUT_MS)}ms`)
}

async function waitForDirectResult(
  files: RunnerFiles,
  initial: RunnerEvent[],
  closed: Promise<void>,
): Promise<SubprocessOutcome> {
  let seen = 0
  const wrapperState = { closed: false }
  void closed.then(() => { wrapperState.closed = true })
  for (;;) {
    // A read started before close may return a stale snapshot after close has
    // become visible. Only a read started after close can prove no terminal
    // event was written before the runner exited.
    const closedBeforeRead = wrapperState.closed
    const events = await readRunnerEventsAsync(files.eventsPath)
    for (const event of events.slice(seen)) {
      if (event.type === 'exit') return { exitCode: event.exitCode, signal: event.signal }
      if (event.type === 'spawn-error' || event.type === 'runner-error') throw deserializeSpawnError(event.error)
    }
    seen = Math.max(seen, events.length, initial.length)
    if (closedBeforeRead) {
      throw new Error('native subprocess runner exited without a direct-command result')
    }
    await sleepMs(RUNNER_EVENT_POLL_MS)
  }
}

/**
 * Bind runner events into one direct result while preserving the target pid.
 * @param child - native wrapper process.
 * @param files - private request and result paths.
 * @param closed - wrapper close observation attached before the start handshake.
 * @returns target pid and direct result promise.
 */
export function runnerDirectResult(
  child: ChildProcess,
  files: RunnerFiles,
  closed: Promise<void>,
): {
  pid: number
  direct: Promise<SubprocessOutcome>
} {
  let handshake: RunnerHandshake
  try {
    handshake = waitForRunnerHandshake(child, files)
  } catch (error) {
    cleanupRunnerFiles(files)
    return { pid: -1, direct: Promise.resolve().then(() => { throw error }) }
  }
  return {
    pid: handshake.pid,
    direct: waitForDirectResult(files, handshake.events, closed),
  }
}

/**
 * Remove request/result files after their reader settles and writer closes.
 * @param files - private request and result paths.
 * @param direct - target result promise.
 * @param closed - runner close observation.
 */
export function cleanupAfterRunner(
  files: RunnerFiles,
  direct: Promise<SubprocessOutcome>,
  closed: Promise<void>,
): void {
  void Promise.allSettled([direct, closed]).then(() => { cleanupRunnerFiles(files) })
}
