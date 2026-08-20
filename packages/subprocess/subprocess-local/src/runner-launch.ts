/** Parent-side launch and direct-result transport for native runners. */

import type { ChildProcess, StdioOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleepMs } from 'node:timers/promises'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  cleanupRunnerFiles,
  createRunnerFiles,
  deserializeSpawnError,
  readRunnerEvents,
} from './runner-protocol.ts'
import type { RunnerEvent, RunnerFiles, RunnerRequest } from './runner-protocol.ts'
import { childEnv } from './spawn.ts'

const handshakeWait = new Int32Array(new SharedArrayBuffer(4))

/**
 * Resolve the built runner in production or its source entry in repository execution.
 * @returns Node executable and runner argv prefix.
 */
export function spawnRunnerInvocation(): string[] {
  const builtEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/spawn-runner'))
  if (existsSync(builtEntry)) return [process.execPath, builtEntry]
  const sourceEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/src/spawn-runner.ts'))
  return [process.execPath, '--import', 'tsx/esm', sourceEntry]
}

/**
 * Build wrapper stdio corresponding to the public target dispositions.
 * @param spec - target stdio request.
 * @param ipc - append a Node IPC channel for the Windows runner.
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

/** Wait synchronously only until the runner reports target start or spawn failure. */
function waitForRunnerHandshake(child: ChildProcess, files: RunnerFiles): RunnerHandshake {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const events = readRunnerEvents(files.eventsPath)
    const terminal = events.find(event => event.type === 'started' || event.type === 'spawn-error' || event.type === 'runner-error')
    if (terminal?.type === 'started') return { pid: terminal.pid, events }
    if (terminal?.type === 'spawn-error' || terminal?.type === 'runner-error') return { pid: -1, events }
    if (child.pid === undefined) throw new Error('native subprocess runner failed to start')
    Atomics.wait(handshakeWait, 0, 0, 5)
  }
  throw new Error('native subprocess runner did not report target start within 10000ms')
}

async function waitForDirectResult(
  files: RunnerFiles,
  initial: RunnerEvent[],
  closed: Promise<void>,
  missingResult?: () => SubprocessOutcome | undefined,
): Promise<SubprocessOutcome> {
  let seen = 0
  let wrapperClosed = false
  void closed.then(() => { wrapperClosed = true })
  for (;;) {
    const events = readRunnerEvents(files.eventsPath)
    for (const event of events.slice(seen)) {
      if (event.type === 'exit') return { exitCode: event.exitCode, signal: event.signal }
      if (event.type === 'spawn-error' || event.type === 'runner-error') throw deserializeSpawnError(event.error)
    }
    seen = Math.max(seen, events.length, initial.length)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- child close mutates this flag asynchronously.
    if (wrapperClosed) {
      const known = missingResult?.()
      if (known !== undefined) return known
      throw new Error('native subprocess runner exited without a direct-command result')
    }
    await sleepMs(10)
  }
}

/**
 * Bind runner events into one direct result while preserving the target pid.
 * @param child - native wrapper process.
 * @param files - private request and result paths.
 * @param closed - wrapper close observation attached before the start handshake.
 * @param missingResult - authoritative outcome available when force-kill prevents a final event.
 * @returns target pid and direct result promise.
 */
export function runnerDirectResult(
  child: ChildProcess,
  files: RunnerFiles,
  closed: Promise<void>,
  missingResult?: () => SubprocessOutcome | undefined,
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
    direct: waitForDirectResult(files, handshake.events, closed, missingResult),
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
