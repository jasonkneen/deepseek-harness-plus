import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { NativePtr } from '@deepseek-ai/dsh-win32-process'
import { appendRunnerEvent } from '../src/runner-protocol.ts'
import { launchWindowsJob, probeWindowsJob } from '../src/windows-job.ts'
import type { WindowsProcessOperations } from '../src/windows-job.ts'

const fixture = fileURLToPath(new URL('fixtures/fake-job-runner.ts', import.meta.url))
const invocation = [process.execPath, '--import', 'tsx/esm', fixture]

function spec(argv: string[]): SubprocessSpawnSpec {
  return {
    argv,
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    graceMs: 100,
  }
}

function fakeRunner(pid: number): { child: ChildProcess; disconnect: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as ChildProcess
  const disconnect = vi.fn(() => {
    Object.assign(child, { connected: false })
    queueMicrotask(() => {
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
    })
  })
  Object.assign(child, { pid, connected: true, disconnect, kill: vi.fn(() => true) })
  return { child, disconnect }
}

function processOperations(overrides: Partial<WindowsProcessOperations> = {}): {
  operations: WindowsProcessOperations
  create: ReturnType<typeof vi.fn>
  openProcess: ReturnType<typeof vi.fn>
  pollProcess: ReturnType<typeof vi.fn>
  empty: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
  closeJob: ReturnType<typeof vi.fn>
  closeProcess: ReturnType<typeof vi.fn>
} {
  const create = vi.fn(() => 50n as NativePtr)
  const openProcess = vi.fn(() => 60n as NativePtr)
  const pollProcess = vi.fn(() => 0)
  const empty = vi.fn(() => true)
  const terminate = vi.fn()
  const closeJob = vi.fn()
  const closeProcess = vi.fn()
  return {
    operations: { create, openProcess, pollProcess, empty, terminate, closeJob, closeProcess, ...overrides },
    create,
    openProcess,
    pollProcess,
    empty,
    terminate,
    closeJob,
    closeProcess,
  }
}

describe('Windows Job runner adapter', () => {
  it('probes the runner before a user command is selected', () => {
    const runSync = vi.fn(() => ({ status: 0, error: undefined })) as unknown as typeof spawnSync
    expect(probeWindowsJob({ spawnSync: runSync, runnerInvocation: invocation })).toBe(true)
    expect(runSync).toHaveBeenCalledWith(
      process.execPath,
      [...invocation.slice(1), '--mode', 'probe-win32'],
      expect.objectContaining({ stdio: 'ignore' }),
    )
    expect(probeWindowsJob({ runnerInvocation: [] })).toBe(false)
    expect(probeWindowsJob({
      spawnSync: vi.fn(() => ({ status: 1, error: undefined })) as unknown as typeof spawnSync,
      runnerInvocation: invocation,
    })).toBe(false)
    expect(probeWindowsJob({
      spawnSync: vi.fn(() => ({ status: 0, error: new Error('probe failed') })) as unknown as typeof spawnSync,
      runnerInvocation: invocation,
    })).toBe(false)
  })

  it('reports direct outcome separately from runner settlement', async () => {
    const jobs = processOperations({ pollProcess: vi.fn(() => 7) })
    const request = {
      ...spec(['fake-target', '7']),
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' } as const,
    }
    const launch = launchWindowsJob(request, {
      spawn,
      runnerInvocation: invocation,
      operations: jobs.operations,
    })
    expect(launch.pid).toBeGreaterThan(0)
    await expect(launch.direct).resolves.toEqual({ exitCode: 7, signal: null })
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    expect(jobs.create).toHaveBeenCalledOnce()
    expect(jobs.create.mock.calls[0]?.[0]).toMatch(/^Local\\dsh-subprocess-/u)
    expect(jobs.openProcess).toHaveBeenCalledWith(launch.pid)
    expect(jobs.closeProcess).toHaveBeenCalledExactlyOnceWith(60n)
    expect(jobs.closeJob).toHaveBeenCalledExactlyOnceWith(50n)
  })

  it('signals and waits through the parent-owned Job', async () => {
    const { child, disconnect } = fakeRunner(321)
    let eventsPath = ''
    const state = { empty: false, exitCode: undefined as number | undefined }
    const terminate = vi.fn(() => {
      state.empty = true
      state.exitCode = 1
    })
    const jobs = processOperations({
      pollProcess: vi.fn(() => state.exitCode),
      empty: vi.fn(() => state.empty),
      terminate,
    })
    const run = vi.fn((_command: string, args: readonly string[]) => {
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 321 })
      return child
    }) as unknown as typeof spawn
    const launch = launchWindowsJob(spec(['fake-target']), {
      spawn: run,
      runnerInvocation: ['fake-runner'],
      operations: jobs.operations,
    })
    launch.owner.signal('SIGTERM')
    await expect(launch.direct).resolves.toEqual({ exitCode: 1, signal: null })
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    launch.owner.signal('SIGKILL')
    expect(disconnect).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledExactlyOnceWith(50n)
    expect(jobs.closeJob).toHaveBeenCalledExactlyOnceWith(50n)
  })

  it('does not treat runner exit as proof that the Job is empty', async () => {
    const { child, disconnect } = fakeRunner(432)
    let eventsPath = ''
    const state = { empty: false, exitCode: undefined as number | undefined }
    const jobs = processOperations({
      pollProcess: vi.fn(() => state.exitCode),
      empty: vi.fn(() => state.empty),
    })
    const run = vi.fn((_command: string, args: readonly string[]) => {
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 432 })
      return child
    }) as unknown as typeof spawn
    const launch = launchWindowsJob(spec(['fake-target']), {
      spawn: run,
      runnerInvocation: ['fake-runner'],
      operations: jobs.operations,
    })
    await expect(launch.owner.waitForExit(AbortSignal.timeout(20))).resolves.toBe(false)
    state.exitCode = 0
    await expect(launch.direct).resolves.toEqual({ exitCode: 0, signal: null })
    state.empty = true
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    launch.owner.signal('SIGKILL')
    expect(disconnect).toHaveBeenCalledOnce()
    expect(jobs.terminate).not.toHaveBeenCalled()
  })

  it('reports Job termination failures through waitForExit', async () => {
    const { child } = fakeRunner(654)
    let eventsPath = ''
    const run = vi.fn((_command: string, args: readonly string[]) => {
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 654 })
      return child
    }) as unknown as typeof spawn
    const failure = new Error('TerminateJobObject failed')
    const jobs = processOperations({ empty: vi.fn(() => false), terminate: vi.fn(() => { throw failure }) })
    const launch = launchWindowsJob(spec(['fake-target']), {
      spawn: run,
      runnerInvocation: ['fake-runner'],
      operations: jobs.operations,
    })
    void launch.direct.catch(() => {})
    launch.owner.signal('SIGTERM')
    await expect(launch.owner.waitForExit()).rejects.toBe(failure)
    await expect(launch.owner.waitForExit()).rejects.toBe(failure)
    expect(jobs.closeJob).toHaveBeenCalledExactlyOnceWith(50n)
  })

  it('keeps a Job observation failure visible on repeated waits', async () => {
    const { child } = fakeRunner(655)
    let eventsPath = ''
    const run = vi.fn((_command: string, args: readonly string[]) => {
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 655 })
      return child
    }) as unknown as typeof spawn
    const failure = new Error('QueryInformationJobObject failed')
    const jobs = processOperations({ empty: vi.fn(() => { throw failure }) })
    const launch = launchWindowsJob(spec(['fake-target']), {
      spawn: run,
      runnerInvocation: ['fake-runner'],
      operations: jobs.operations,
    })
    await expect(launch.direct).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(launch.owner.waitForExit()).rejects.toBe(failure)
    await expect(launch.owner.waitForExit()).rejects.toBe(failure)
    expect(jobs.closeJob).toHaveBeenCalledExactlyOnceWith(50n)
  })

  it('reports direct-process observation failure and closes its handle', async () => {
    const { child } = fakeRunner(656)
    let eventsPath = ''
    const run = vi.fn((_command: string, args: readonly string[]) => {
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 656 })
      return child
    }) as unknown as typeof spawn
    const failure = new Error('WaitForSingleObject failed')
    const jobs = processOperations({ pollProcess: vi.fn(() => { throw failure }) })
    const launch = launchWindowsJob(spec(['fake-target']), {
      spawn: run,
      runnerInvocation: ['fake-runner'],
      operations: jobs.operations,
    })
    await expect(launch.direct).rejects.toBe(failure)
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    expect(jobs.closeProcess).toHaveBeenCalledExactlyOnceWith(60n)
  })

  it('releases the runner when the parent cannot open the direct process', async () => {
    const { child, disconnect } = fakeRunner(659)
    let eventsPath = ''
    const run = vi.fn((_command: string, args: readonly string[]) => {
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 659 })
      return child
    }) as unknown as typeof spawn
    const failure = new Error('OpenProcess failed')
    const jobs = processOperations({ openProcess: vi.fn(() => { throw failure }) })
    const launch = launchWindowsJob(spec(['fake-target']), {
      spawn: run,
      runnerInvocation: ['fake-runner'],
      operations: jobs.operations,
    })
    await expect(launch.direct).rejects.toBe(failure)
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    expect(disconnect).toHaveBeenCalledOnce()
    expect(jobs.closeProcess).not.toHaveBeenCalled()
  })

  it('reports a failed runner release after acquiring direct-process observation', async () => {
    const child = new EventEmitter() as ChildProcess
    const failure = new Error('IPC disconnect failed')
    const kill = vi.fn(() => {
      queueMicrotask(() => { child.emit('exit', 0, null) })
      return true
    })
    Object.assign(child, {
      pid: 657,
      connected: true,
      disconnect: vi.fn(() => { throw failure }),
      kill,
    })
    let eventsPath = ''
    const run = vi.fn((_command: string, args: readonly string[]) => {
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 657 })
      return child
    }) as unknown as typeof spawn
    const jobs = processOperations()
    const launch = launchWindowsJob(spec(['fake-target']), {
      spawn: run,
      runnerInvocation: ['fake-runner'],
      operations: jobs.operations,
    })
    await expect(launch.direct).rejects.toBe(failure)
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    expect(kill).toHaveBeenCalledOnce()
  })

  it('keeps collected settlement pending until the runner and collected streams close', async () => {
    const { child } = fakeRunner(658)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    Object.assign(child, { stdout, stderr })
    let eventsPath = ''
    const run = vi.fn((_command: string, args: readonly string[]) => {
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 658 })
      return child
    }) as unknown as typeof spawn
    const jobs = processOperations()
    const launch = launchWindowsJob(spec(['fake-target']), {
      spawn: run,
      runnerInvocation: ['fake-runner'],
      operations: jobs.operations,
    })
    let closed = false
    void launch.closed.then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(closed).toBe(false)
    stdout.resume()
    stderr.resume()
    stdout.end()
    stderr.end()
    await expect(launch.closed).resolves.toBeUndefined()
  })

  it('closes the parent Job when spawning the runner throws synchronously', () => {
    const failure = new Error('runner spawn failed')
    const jobs = processOperations()
    expect(() => launchWindowsJob(spec(['fake-target']), {
      spawn: vi.fn(() => { throw failure }) as unknown as typeof spawn,
      runnerInvocation: ['fake-runner'],
      operations: jobs.operations,
    })).toThrow(failure)
    expect(jobs.closeJob).toHaveBeenCalledExactlyOnceWith(50n)
  })

  it('passes a generated Job name to the runner and rejects an empty invocation', async () => {
    const emptyJobs = processOperations()
    expect(() => launchWindowsJob(spec(['fake-target']), {
      runnerInvocation: [],
      operations: emptyJobs.operations,
    }))
      .toThrow('Windows runner invocation is empty')
    expect(emptyJobs.create).not.toHaveBeenCalled()

    const { child, disconnect } = fakeRunner(987)
    let eventsPath = ''
    let jobName = ''
    const run = vi.fn((_command: string, args: readonly string[]) => {
      jobName = args[args.indexOf('--job') + 1] as string
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 987 })
      return child
    }) as unknown as typeof spawn
    const jobs = processOperations()
    const launch = launchWindowsJob(spec(['fake-target']), {
      spawn: run,
      runnerInvocation: ['fake-runner'],
      operations: jobs.operations,
    })
    await expect(launch.direct).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    expect(disconnect).toHaveBeenCalledOnce()
    expect(jobName).toMatch(/^Local\\dsh-subprocess-/u)
    expect(jobs.create).toHaveBeenCalledExactlyOnceWith(jobName)
  })
})
