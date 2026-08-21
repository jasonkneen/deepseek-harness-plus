/** Windows Job runner launch and managed-range ownership. */

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleepMs } from 'node:timers/promises'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  closeHandleChecked,
  createKillOnCloseJob,
  isJobEmpty,
  loadWin32ProcessBindings,
  terminateJob,
} from '@deepseek-ai/dsh-win32-process'
import type { NativePtr } from '@deepseek-ai/dsh-win32-process'
import type { BoundProcessOwner, ManagedProcessLaunch } from './managed-owner.ts'
import { observeChildClose, waitWithAbort } from './managed-owner.ts'
import { childEnv } from './spawn.ts'
import {
  cleanupAfterRunner,
  runnerDirectResult,
  runnerFiles,
  runnerStdio,
  spawnRunnerInvocation,
} from './runner-launch.ts'
import { cleanupRunnerFiles } from './runner-protocol.ts'

const JOB_POLL_INTERVAL_MS = 10

/** Parent-side operations for one Windows Job handle. */
export interface WindowsJobOperations {
  create(name: string): NativePtr
  empty(job: NativePtr): boolean
  terminate(job: NativePtr): void
  close(job: NativePtr): void
}

function nativeJobOperations(): WindowsJobOperations {
  const api = loadWin32ProcessBindings()
  return {
    create: name => createKillOnCloseJob(api, name),
    empty: job => isJobEmpty(api, job),
    terminate: (job) => { terminateJob(api, job, 1) },
    close: (job) => { closeHandleChecked(api, job, 'ordinary process Job') },
  }
}

/** Test seams for the runner process. */
export interface WindowsJobInternals {
  spawn?: typeof spawn
  spawnSync?: typeof spawnSync
  runnerInvocation?: string[]
  jobs?: WindowsJobOperations
  jobName?: () => string
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
  private closed = false
  private terminationRequested = false
  private terminationFailure: Error | undefined
  private observation: Promise<void> | undefined

  constructor(
    private readonly job: NativePtr,
    private readonly operations: WindowsJobOperations,
    private readonly runnerClosed: Promise<void>,
  ) {}

  signal(_signal: NodeJS.Signals): void {
    if (this.stopped || this.terminationRequested) return
    this.terminationRequested = true
    try {
      this.operations.terminate(this.job)
    } catch (error) {
      this.terminationFailure = error instanceof Error ? error : new Error(String(error))
    }
  }

  waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.observation !== undefined) return waitWithAbort(this.observation, signal)
    if (this.stopped) return Promise.resolve(true)
    this.observation = (async () => {
      try {
        while (!this.operations.empty(this.job)) {
          if (this.terminationFailure !== undefined) throw this.terminationFailure
          await sleepMs(JOB_POLL_INTERVAL_MS)
        }
        this.stopped = true
        this.close()
        await this.runnerClosed
      } catch (error) {
        this.stopped = true
        try { this.close() } catch { /* Preserve the observation failure. */ }
        throw error
      }
    })()
    return waitWithAbort(this.observation, signal)
  }

  private close(): void {
    if (this.closed) return
    this.operations.close(this.job)
    this.closed = true
  }
}

/**
 * Launch one direct command through a runner into a parent-owned Job.
 * @param spec - exact target argv, cwd, stdio, environment, and lifecycle settings.
 * @param internals - injected process runner used by tests.
 * @returns wrapper streams, target outcome, and the bound Job owner.
 */
export function launchWindowsJob(
  spec: SubprocessSpawnSpec,
  internals: WindowsJobInternals = {},
): ManagedProcessLaunch {
  const run = internals.spawn ?? spawn
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const [command, ...prefix] = invocation
  if (command === undefined) throw new Error('subprocess-local: Windows runner invocation is empty')
  /* v8 ignore next -- the native Windows suite exercises the real Job operations. */
  const jobs = internals.jobs ?? nativeJobOperations()
  const jobName = (internals.jobName ?? (() => `Local\\dsh-subprocess-${randomUUID()}`))()
  const files = runnerFiles(spec)
  let job: NativePtr
  try {
    job = jobs.create(jobName)
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
      '--job',
      jobName,
      '--request',
      files.requestPath,
      '--events',
      files.eventsPath,
    ], {
      env: childEnv(),
      stdio: runnerStdio(spec),
    })
  } catch (error) {
    try { jobs.close(job) } catch { /* Preserve the launch failure. */ }
    cleanupRunnerFiles(files)
    throw error
  }
  const closed = observeChildClose(child)
  const owner = new WindowsJobOwner(job, jobs, closed)
  const result = runnerDirectResult(child, files, closed)
  cleanupAfterRunner(files, result.direct, closed)
  return { child, pid: result.pid, direct: result.direct, closed, owner }
}
