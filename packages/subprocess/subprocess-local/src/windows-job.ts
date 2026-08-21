/** Windows Job runner launch and managed-range ownership. */

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { BoundProcessOwner, ManagedProcessLaunch } from './managed-owner.ts'
import { observeChildClose, waitWithAbort } from './managed-owner.ts'
import { childEnv } from './spawn.ts'
import {
  cleanupAfterRunner,
  runnerDirectResult,
  runnerFiles,
  spawnRunnerInvocation,
} from './runner-launch.ts'
import { cleanupRunnerFiles } from './runner-protocol.ts'
import { createWindowsStdioBridge } from './windows-stdio.ts'

function observeCollectedStream(
  mode: SubprocessSpawnSpec['stdio']['stdout'],
  stream: Readable | null,
): Promise<void> {
  if (mode === 'pipe' || mode === 'inherit') return Promise.resolve()
  // The bridge creates collect streams synchronously before the runner starts.
  const collected = stream as Readable
  return new Promise((resolve) => {
    const settle = (): void => {
      collected.off('end', settle)
      collected.off('close', settle)
      collected.off('error', settle)
      resolve()
    }
    collected.once('end', settle)
    collected.once('close', settle)
    collected.once('error', settle)
  })
}

/** Test seams for the runner process. */
export interface WindowsJobInternals {
  spawn?: typeof spawn
  spawnSync?: typeof spawnSync
  runnerInvocation?: string[]
}

/**
 * Confirm in a separate process that shared Win32 bindings and the runner entry are available.
 * @param internals - injected process runners used by tests.
 * @returns true when native launch can be selected before a user command.
 */
export function probeWindowsJob(internals: WindowsJobInternals = {}): boolean {
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const [command, ...prefix] = invocation
  if (command === undefined) return false
  const result = (internals.spawnSync ?? spawnSync)(command, [...prefix, '--mode', 'probe-win32'], {
    env: childEnv(),
    stdio: 'ignore',
    timeout: 5_000,
  })
  return result.error === undefined && result.status === 0
}

class WindowsJobOwner implements BoundProcessOwner {
  private stopped = false
  private runnerClosed = false
  private readonly observation: Promise<void>

  constructor(
    private readonly runner: ReturnType<typeof spawn>,
    private readonly startupFailureReported: boolean,
  ) {
    this.observation = new Promise((resolve, reject) => {
      runner.once('close', (exitCode, signal) => {
        this.runnerClosed = true
        if (this.startupFailureReported || this.runner.pid === undefined || (exitCode === 0 && signal === null)) {
          this.stopped = true
          resolve()
          return
        }
        const status = signal !== null
          ? `signal ${signal}`
          : exitCode === null
            ? 'without an exit status'
            : `exit code ${String(exitCode)}`
        reject(new Error(
          `subprocess-local: Windows Job runner exited with ${status} before proving its managed range empty`,
        ))
      })
    })
    void this.observation.catch(() => {})
  }

  signal(_signal: NodeJS.Signals): void {
    if (this.stopped || this.runnerClosed || this.startupFailureReported || this.runner.pid === undefined) return
    try {
      if (this.runner.connected) {
        this.runner.send({ type: 'terminate' }, (error) => {
          if (error !== null) this.runner.kill()
        })
      } else {
        this.runner.kill()
      }
    } catch {
      this.runner.kill()
    }
  }

  waitForExit(signal?: AbortSignal): Promise<boolean> {
    return this.stopped ? Promise.resolve(true) : waitWithAbort(this.observation, signal)
  }
}

/**
 * Launch one direct command through the Job-owning runner.
 * @param spec - exact target argv, cwd, stdio, environment, and lifecycle settings.
 * @param internals - injected process runner used by tests.
 * @returns parent-owned streams, target outcome, and the bound Job owner.
 */
export function launchWindowsJob(
  spec: SubprocessSpawnSpec,
  internals: WindowsJobInternals = {},
): ManagedProcessLaunch {
  const run = internals.spawn ?? spawn
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const [command, ...prefix] = invocation
  if (command === undefined) throw new Error('subprocess-local: Windows runner invocation is empty')
  const files = runnerFiles(spec)
  let stdio: ReturnType<typeof createWindowsStdioBridge>
  try {
    stdio = createWindowsStdioBridge(
      spec,
      `\\\\.\\pipe\\dsh-subprocess-${String(process.pid)}-${randomUUID()}`,
    )
  } catch (error) {
    cleanupRunnerFiles(files)
    throw error
  }
  let child: ReturnType<typeof spawn>
  try {
    child = run(command, [
      ...prefix,
      '--mode',
      'win32',
      '--request',
      files.requestPath,
      '--events',
      files.eventsPath,
      ...stdio.runnerArgs,
    ], {
      env: childEnv(),
      stdio: stdio.runnerStdio,
    })
  } catch (error) {
    stdio.dispose()
    cleanupRunnerFiles(files)
    throw error
  }
  const runnerClosed = observeChildClose(child)
  const closed = Promise.all([
    observeCollectedStream(spec.stdio.stdout, stdio.stdout),
    observeCollectedStream(spec.stdio.stderr, stdio.stderr),
  ]).then(() => undefined)
  const result = runnerDirectResult(child, files, runnerClosed)
  const owner = new WindowsJobOwner(child, result.failureReported)
  void result.direct.then(
    () => { stdio.closeInput() },
    () => { stdio.dispose() },
  )
  cleanupAfterRunner(files, result.direct, runnerClosed)
  return {
    stdin: stdio.stdin,
    stdout: stdio.stdout,
    stderr: stdio.stderr,
    pid: result.pid,
    direct: result.direct,
    closed,
    owner,
  }
}
