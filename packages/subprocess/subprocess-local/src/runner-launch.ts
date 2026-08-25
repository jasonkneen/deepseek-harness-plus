/** Parent-side launch and direct-result transport for native runners. */

import type { ChildProcess, StdioOptions } from 'node:child_process'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleepMs } from 'node:timers/promises'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  cleanupRunnerFiles,
  createRunnerFiles,
  deserializeSpawnError,
  readRunnerEventsAsync,
} from './runner-protocol.ts'
import type { RunnerEvent, RunnerFiles, RunnerRequest } from './runner-protocol.ts'
import { DirectResultUnavailableError } from './managed-owner.ts'
import { childEnv } from './spawn.ts'

const RUNNER_EVENT_POLL_MS = 100
const PACKAGED_RUNNER_ARG = '--dsh-internal-subprocess-runner'

/** Non-empty command tuple used to launch the private native runner. */
export type RunnerInvocation = [string, ...string[]]

/**
 * Resolve the runner entry from the current module's source or built plane.
 * @returns Node executable and runner argv prefix.
 */
export function spawnRunnerInvocation(): RunnerInvocation {
  if ('pkg' in process) return [process.execPath, PACKAGED_RUNNER_ARG]
  /* v8 ignore start -- source-plane coverage cannot execute the bundled module;
     the required built-runner smoke executes its published entry. */
  if (extname(fileURLToPath(import.meta.url)) !== '.ts') {
    const builtEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/spawn-runner'))
    return [process.execPath, builtEntry]
  }
  /* v8 ignore stop */
  const sourceEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/src/bin.ts'))
  return [process.execPath, '--import', 'tsx/esm', sourceEntry]
}

/**
 * Build wrapper stdio corresponding to the public target dispositions.
 * @param spec - target stdio request.
 * @returns child-process stdio configuration.
 */
export function runnerStdio(spec: SubprocessSpawnSpec): StdioOptions {
  return [
    spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe',
    spec.stdio.stdout === 'inherit' ? 'inherit' : 'pipe',
    spec.stdio.stderr === 'inherit' ? 'inherit' : 'pipe',
  ]
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

function directTerminalResult(
  events: readonly RunnerEvent[],
): { outcome: SubprocessOutcome } | { error: Error } | undefined {
  for (const event of events) {
    if (event.type === 'exit') {
      return { outcome: { exitCode: event.exitCode, signal: event.signal } }
    }
    if (event.type === 'spawn-error' || event.type === 'runner-error') {
      return { error: deserializeSpawnError(event.error) }
    }
  }
  return undefined
}

async function waitForDirectResult(
  child: ChildProcess,
  files: RunnerFiles,
  exited: Promise<void>,
  publishPid: (pid: number) => void,
): Promise<SubprocessOutcome> {
  let seen = 0
  const wrapperState = { exited: false }
  void exited.then(() => { wrapperState.exited = true })
  for (;;) {
    // A read started before exit may return a stale snapshot after exit has
    // become visible. Only a read started after exit can prove no terminal
    // event was written before the runner exited.
    const exitedBeforeRead = wrapperState.exited
    const events = await readRunnerEventsAsync(files.eventsPath)
    const added = events.slice(seen)
    for (const event of added) {
      if (event.type === 'started') publishPid(event.pid)
    }
    const terminal = directTerminalResult(added)
    if (terminal !== undefined) {
      if ('error' in terminal) throw terminal.error
      return terminal.outcome
    }
    seen = Math.max(seen, events.length)
    if (exitedBeforeRead) {
      if (child.pid === undefined) throw new Error('native subprocess runner failed to start')
      throw new DirectResultUnavailableError('native subprocess runner exited without a direct-command result')
    }
    await sleepMs(RUNNER_EVENT_POLL_MS)
  }
}

/**
 * Bind asynchronous runner events into one direct result and target-pid getter.
 * @param child - native wrapper process.
 * @param files - private request and result paths.
 * @param exited - wrapper exit/error observation attached before event polling.
 * @returns a live target-pid view plus the direct result.
 */
export function runnerDirectResult(
  child: ChildProcess,
  files: RunnerFiles,
  exited: Promise<void>,
): {
  readonly pid: number | undefined
  direct: Promise<SubprocessOutcome>
} {
  let pid: number | undefined
  return {
    get pid() { return pid },
    direct: waitForDirectResult(child, files, exited, (published) => { pid = published }),
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
