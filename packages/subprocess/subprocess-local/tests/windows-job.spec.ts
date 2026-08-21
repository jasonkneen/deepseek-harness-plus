import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { NativePtr } from '@deepseek-ai/dsh-win32-process'
import { appendRunnerEvent } from '../src/runner-protocol.ts'
import { launchWindowsJob, probeWindowsJob } from '../src/windows-job.ts'
import type { WindowsJobOperations } from '../src/windows-job.ts'

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

function jobOperations(overrides: Partial<WindowsJobOperations> = {}): {
  operations: WindowsJobOperations
  create: ReturnType<typeof vi.fn>
  empty: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  const create = vi.fn(() => 50n as NativePtr)
  const empty = vi.fn(() => true)
  const terminate = vi.fn()
  const close = vi.fn()
  return {
    operations: { create, empty, terminate, close, ...overrides },
    create,
    empty,
    terminate,
    close,
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
    const jobs = jobOperations()
    const launch = launchWindowsJob(spec(['fake-target', '7']), {
      spawn,
      runnerInvocation: invocation,
      jobs: jobs.operations,
      jobName: () => 'Local\\dsh-test-job',
    })
    expect(launch.pid).toBeGreaterThan(0)
    await expect(launch.direct).resolves.toEqual({ exitCode: 7, signal: null })
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    expect(jobs.create).toHaveBeenCalledExactlyOnceWith('Local\\dsh-test-job')
    expect(jobs.close).toHaveBeenCalledExactlyOnceWith(50n)
  })

  it('signals and waits through the parent-owned Job', async () => {
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 321 })
    let eventsPath = ''
    let empty = false
    const terminate = vi.fn(() => {
      empty = true
      appendRunnerEvent(eventsPath, { type: 'exit', exitCode: 1, signal: null })
      child.emit('close', 0, null)
    })
    const jobs = jobOperations({
      empty: vi.fn(() => empty),
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
      jobs: jobs.operations,
      jobName: () => 'Local\\dsh-test-job',
    })
    launch.owner.signal('SIGTERM')
    await expect(launch.direct).resolves.toEqual({ exitCode: 1, signal: null })
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    launch.owner.signal('SIGKILL')
    expect(terminate).toHaveBeenCalledExactlyOnceWith(50n)
    expect(jobs.close).toHaveBeenCalledExactlyOnceWith(50n)
  })

  it('does not treat runner exit as proof that the Job is empty', async () => {
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 432 })
    let eventsPath = ''
    let empty = false
    const jobs = jobOperations({ empty: vi.fn(() => empty) })
    const run = vi.fn((_command: string, args: readonly string[]) => {
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 432 })
      return child
    }) as unknown as typeof spawn
    const launch = launchWindowsJob(spec(['fake-target']), {
      spawn: run,
      runnerInvocation: ['fake-runner'],
      jobs: jobs.operations,
      jobName: () => 'Local\\dsh-test-job',
    })
    const directFailure = launch.direct.catch((error: unknown) => error)

    child.emit('close', 127, null)

    await expect(launch.owner.waitForExit(AbortSignal.timeout(20))).resolves.toBe(false)
    await expect(directFailure).resolves.toBeInstanceOf(Error)
    empty = true
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    launch.owner.signal('SIGKILL')
    expect(jobs.terminate).not.toHaveBeenCalled()
  })

  it('reports Job termination failures through waitForExit', async () => {
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 654 })
    let eventsPath = ''
    const run = vi.fn((_command: string, args: readonly string[]) => {
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 654 })
      return child
    }) as unknown as typeof spawn
    const failure = new Error('TerminateJobObject failed')
    const jobs = jobOperations({ empty: vi.fn(() => false), terminate: vi.fn(() => { throw failure }) })
    const launch = launchWindowsJob(spec(['fake-target']), {
      spawn: run,
      runnerInvocation: ['fake-runner'],
      jobs: jobs.operations,
      jobName: () => 'Local\\dsh-test-job',
    })
    void launch.direct.catch(() => {})
    launch.owner.signal('SIGTERM')
    await expect(launch.owner.waitForExit()).rejects.toBe(failure)
    await expect(launch.owner.waitForExit()).rejects.toBe(failure)
    expect(jobs.close).toHaveBeenCalledExactlyOnceWith(50n)
  })

  it('keeps a Job observation failure visible on repeated waits', async () => {
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 655 })
    let eventsPath = ''
    const run = vi.fn((_command: string, args: readonly string[]) => {
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 655 })
      return child
    }) as unknown as typeof spawn
    const failure = new Error('QueryInformationJobObject failed')
    const jobs = jobOperations({ empty: vi.fn(() => { throw failure }) })
    const launch = launchWindowsJob(spec(['fake-target']), {
      spawn: run,
      runnerInvocation: ['fake-runner'],
      jobs: jobs.operations,
      jobName: () => 'Local\\dsh-test-job',
    })
    appendRunnerEvent(eventsPath, { type: 'exit', exitCode: 0, signal: null })
    child.emit('close', 0, null)
    await expect(launch.direct).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(launch.owner.waitForExit()).rejects.toBe(failure)
    await expect(launch.owner.waitForExit()).rejects.toBe(failure)
    expect(jobs.close).toHaveBeenCalledExactlyOnceWith(50n)
  })

  it('closes the parent Job when spawning the runner throws synchronously', () => {
    const failure = new Error('runner spawn failed')
    const jobs = jobOperations()
    expect(() => launchWindowsJob(spec(['fake-target']), {
      spawn: vi.fn(() => { throw failure }) as unknown as typeof spawn,
      runnerInvocation: ['fake-runner'],
      jobs: jobs.operations,
      jobName: () => 'Local\\dsh-test-job',
    })).toThrow(failure)
    expect(jobs.close).toHaveBeenCalledExactlyOnceWith(50n)
  })

  it('passes a generated Job name to the runner and rejects an empty invocation', async () => {
    const emptyJobs = jobOperations()
    expect(() => launchWindowsJob(spec(['fake-target']), {
      runnerInvocation: [],
      jobs: emptyJobs.operations,
    }))
      .toThrow('Windows runner invocation is empty')
    expect(emptyJobs.create).not.toHaveBeenCalled()

    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 987 })
    let eventsPath = ''
    let jobName = ''
    const run = vi.fn((_command: string, args: readonly string[]) => {
      jobName = args[args.indexOf('--job') + 1] as string
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 987 })
      return child
    }) as unknown as typeof spawn
    const jobs = jobOperations()
    const launch = launchWindowsJob(spec(['fake-target']), {
      spawn: run,
      runnerInvocation: ['fake-runner'],
      jobs: jobs.operations,
    })
    appendRunnerEvent(eventsPath, { type: 'exit', exitCode: 0, signal: null })
    child.emit('close', 0, null)
    await expect(launch.direct).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    expect(jobName).toMatch(/^Local\\dsh-subprocess-/u)
  })
})
