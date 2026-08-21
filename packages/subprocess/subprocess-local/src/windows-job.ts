/** Windows Job runner launch and managed-range ownership. */

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import { setTimeout as sleepMs } from 'node:timers/promises'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  closeHandleChecked,
  createKillOnCloseJob,
  isJobEmpty,
  loadWin32ProcessBindings,
  openProcessForWait,
  pollProcessExit,
  terminateJob,
} from '@deepseek-ai/dsh-win32-process'
import type { NativePtr } from '@deepseek-ai/dsh-win32-process'
import type { BoundProcessOwner, ManagedProcessLaunch } from './managed-owner.ts'
import { waitWithAbort } from './managed-owner.ts'
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
const PROCESS_POLL_INTERVAL_MS = 10

/** Parent-side operations for one Windows managed launch. */
export interface WindowsProcessOperations {
  create(name: string): NativePtr
  openProcess(pid: number): NativePtr
  pollProcess(process: NativePtr): number | undefined
  empty(job: NativePtr): boolean
  terminate(job: NativePtr): void
  closeJob(job: NativePtr): void
  closeProcess(process: NativePtr): void
}

function nativeProcessOperations(): WindowsProcessOperations {
  const api = loadWin32ProcessBindings()
  return {
    create: name => createKillOnCloseJob(api, name),
    openProcess: pid => openProcessForWait(api, pid),
    pollProcess: process => pollProcessExit(api, process),
    empty: job => isJobEmpty(api, job),
    terminate: (job) => { terminateJob(api, job, 1) },
    closeJob: (job) => { closeHandleChecked(api, job, 'ordinary process Job') },
    closeProcess: (process) => { closeHandleChecked(api, process, 'ordinary direct process') },
  }
}

function releaseRunner(child: ReturnType<typeof spawn>): Error | undefined {
  if (!child.connected) return undefined
  try {
    child.disconnect()
    return undefined
  } catch (error) {
    try { child.kill() } catch { /* The direct process and Job remain parent-owned. */ }
    return error instanceof Error ? error : new Error(String(error))
  }
}

function observeRunnerExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    child.once('error', () => { resolve() })
    child.once('exit', () => { resolve() })
  })
}

function observeCollectedStream(
  mode: SubprocessSpawnSpec['stdio']['stdout'],
  stream: Readable | null | undefined,
): Promise<void> {
  if (mode === 'pipe' || mode === 'inherit' || stream === null || stream === undefined
    || stream.readableEnded || stream.destroyed) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const settle = (): void => {
      stream.off('end', settle)
      stream.off('close', settle)
      stream.off('error', settle)
      resolve()
    }
    stream.once('end', settle)
    stream.once('close', settle)
    stream.once('error', settle)
  })
}

/** Test seams for the runner process. */
export interface WindowsJobInternals {
  spawn?: typeof spawn
  spawnSync?: typeof spawnSync
  runnerInvocation?: string[]
  operations?: WindowsProcessOperations
}

function observeDirectProcess(
  pid: number,
  operations: WindowsProcessOperations,
): Promise<SubprocessOutcome> {
  const processHandle = operations.openProcess(pid)
  let closed = false
  const close = (): void => {
    if (closed) return
    operations.closeProcess(processHandle)
    closed = true
  }
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      try {
        const exitCode = operations.pollProcess(processHandle)
        if (exitCode === undefined) {
          setTimeout(poll, PROCESS_POLL_INTERVAL_MS)
          return
        }
        close()
        resolve({ exitCode, signal: null })
      } catch (error) {
        try { close() } catch { /* Preserve the observation failure. */ }
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    poll()
  })
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
    private readonly operations: WindowsProcessOperations,
    private readonly runnerExited: Promise<void>,
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
        await this.runnerExited
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
    this.operations.closeJob(this.job)
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
  const operations = internals.operations ?? nativeProcessOperations()
  const jobName = `Local\\dsh-subprocess-${randomUUID()}`
  const files = runnerFiles(spec)
  let job: NativePtr
  try {
    job = operations.create(jobName)
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
      stdio: runnerStdio(spec, true),
    })
  } catch (error) {
    try { operations.closeJob(job) } catch { /* Preserve the launch failure. */ }
    cleanupRunnerFiles(files)
    throw error
  }
  const runnerExited = observeRunnerExit(child)
  const closed = Promise.all([
    runnerExited,
    observeCollectedStream(spec.stdio.stdout, child.stdout),
    observeCollectedStream(spec.stdio.stderr, child.stderr),
  ]).then(() => undefined)
  const owner = new WindowsJobOwner(job, operations, runnerExited)
  const transport = runnerDirectResult(child, files, runnerExited)
  if (transport.pid <= 0) {
    cleanupAfterRunner(files, transport.direct, runnerExited)
    return { child, pid: transport.pid, direct: transport.direct, closed, owner }
  }
  // The launcher retains its original process handle until this process opens
  // an independent one, preventing PID reuse during the ownership handoff.
  // Its event reader then becomes intentionally irrelevant: Windows direct
  // settlement is owned by the handle below, not by the released runner.
  void transport.direct.catch(() => {})
  let direct: Promise<SubprocessOutcome>
  try {
    direct = observeDirectProcess(transport.pid, operations)
  } catch (error) {
    direct = Promise.resolve().then(() => { throw error })
  }
  const releaseFailure = releaseRunner(child)
  if (releaseFailure !== undefined) {
    void direct.catch(() => {})
    direct = Promise.resolve().then(() => { throw releaseFailure })
  }
  cleanupAfterRunner(files, direct, runnerExited)
  return { child, pid: transport.pid, direct, closed, owner }
}
