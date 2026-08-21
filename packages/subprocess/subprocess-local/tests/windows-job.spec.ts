import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { appendRunnerEvent } from '../src/runner-protocol.ts'
import { launchWindowsJob, probeWindowsJob } from '../src/windows-job.ts'

const fixture = fileURLToPath(new URL('fixtures/fake-job-runner.ts', import.meta.url))
const invocation = [process.execPath, '--import', 'tsx/esm', fixture]

function spec(argv: string[]): SubprocessSpawnSpec {
  return {
    argv,
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    graceMs: 100,
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
    const launch = launchWindowsJob(spec(['fake-target', '7']), {
      spawn,
      runnerInvocation: invocation,
    })
    expect(launch.pid).toBeGreaterThan(0)
    await expect(launch.direct).resolves.toEqual({ exitCode: 7, signal: null })
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
  })

  it('signals the Job runner and waits for its managed range to stop', async () => {
    const launch = launchWindowsJob(spec(['fake-target']), {
      spawn,
      runnerInvocation: invocation,
    })
    launch.owner.signal('SIGTERM')
    await expect(launch.direct).resolves.toEqual({ exitCode: 1, signal: null })
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    launch.owner.signal('SIGKILL')
  })

  it.each([
    { exitCode: 127, signal: null, status: 'exit code 127' },
    { exitCode: null, signal: 'SIGTERM' as NodeJS.Signals, status: 'signal SIGTERM' },
    { exitCode: null, signal: null, status: 'without an exit status' },
  ])('rejects range settlement when the runner exits with $status', async ({ exitCode, signal, status }) => {
    const child = new EventEmitter() as ChildProcess
    const kill = vi.fn(() => true)
    Object.assign(child, { pid: 432, connected: false, kill })
    let eventsPath = ''
    const run = vi.fn((_command: string, args: readonly string[]) => {
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 432 })
      return child
    }) as unknown as typeof spawn
    const launch = launchWindowsJob(spec(['fake-target']), { spawn: run, runnerInvocation: ['fake-runner'] })
    const directFailure = launch.direct.catch((error: unknown) => error)

    child.emit('close', exitCode, signal)

    await expect(launch.owner.waitForExit()).rejects.toThrow(
      `Windows Job runner exited with ${status} before proving its managed range empty`,
    )
    await expect(directFailure).resolves.toBeInstanceOf(Error)
    launch.owner.signal('SIGKILL')
    expect(kill).not.toHaveBeenCalled()
  })

  it('falls back to killing the runner when IPC delivery is unavailable or fails', async () => {
    for (const mode of ['callback-error', 'disconnected', 'throw'] as const) {
      const child = new EventEmitter() as ChildProcess
      const kill = vi.fn(() => true)
      const send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => {
        if (mode === 'throw') throw new Error('send threw')
        callback(mode === 'callback-error' ? new Error('send failed') : null)
        return true
      })
      Object.assign(child, {
        pid: 321,
        connected: mode !== 'disconnected',
        kill,
        send,
      })
      let eventsPath = ''
      const run = vi.fn((_command: string, args: readonly string[]) => {
        eventsPath = args[args.indexOf('--events') + 1] as string
        appendRunnerEvent(eventsPath, { type: 'started', pid: 321 })
        return child
      }) as unknown as typeof spawn
      const launch = launchWindowsJob(spec(['fake-target']), { spawn: run, runnerInvocation: ['fake-runner'] })

      launch.owner.signal('SIGTERM')
      if (mode === 'callback-error' || mode === 'throw' || mode === 'disconnected') {
        expect(kill).toHaveBeenCalledOnce()
      }
      if (mode === 'disconnected') expect(send).not.toHaveBeenCalled()

      appendRunnerEvent(eventsPath, { type: 'exit', exitCode: 0, signal: null })
      child.emit('close', null, 'SIGTERM')
      await expect(launch.direct).resolves.toEqual({ exitCode: 0, signal: null })
      await expect(launch.owner.waitForExit()).rejects.toThrow('before proving its managed range empty')
      const sends = send.mock.calls.length
      const kills = kill.mock.calls.length
      launch.owner.signal('SIGKILL')
      expect(send).toHaveBeenCalledTimes(sends)
      expect(kill).toHaveBeenCalledTimes(kills)
    }

    const child = new EventEmitter() as ChildProcess
    const kill = vi.fn(() => true)
    const send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => {
      callback(null)
      return true
    })
    Object.assign(child, { pid: 654, connected: true, kill, send })
    let eventsPath = ''
    const run = vi.fn((_command: string, args: readonly string[]) => {
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 654 })
      return child
    }) as unknown as typeof spawn
    const launch = launchWindowsJob(spec(['fake-target']), { spawn: run, runnerInvocation: ['fake-runner'] })
    launch.owner.signal('SIGTERM')
    expect(send).toHaveBeenCalledOnce()
    expect(kill).not.toHaveBeenCalled()
    appendRunnerEvent(eventsPath, { type: 'exit', exitCode: 0, signal: null })
    child.emit('close', 0, null)
    await launch.direct
    await launch.owner.waitForExit()
  })

  it('uses production runner defaults and rejects an empty invocation', async () => {
    expect(() => launchWindowsJob(spec(['fake-target']), { runnerInvocation: [] }))
      .toThrow('Windows runner invocation is empty')

    const child = new EventEmitter() as ChildProcess
    Object.assign(child, {
      pid: 987,
      connected: true,
      kill: vi.fn(() => true),
      send: vi.fn(),
    })
    let eventsPath = ''
    const run = vi.fn((_command: string, args: readonly string[]) => {
      eventsPath = args[args.indexOf('--events') + 1] as string
      appendRunnerEvent(eventsPath, { type: 'started', pid: 987 })
      return child
    })
    const runSync = vi.fn(() => ({ status: 0, error: undefined }))
    vi.resetModules()
    vi.doMock('node:child_process', async importOriginal => ({
      ...await importOriginal<typeof import('node:child_process')>(),
      spawn: run,
      spawnSync: runSync,
    }))
    try {
      const defaults = await import('../src/windows-job.ts')
      expect(defaults.probeWindowsJob()).toBe(true)
      const launch = defaults.launchWindowsJob(spec(['fake-target']))
      appendRunnerEvent(eventsPath, { type: 'exit', exitCode: 0, signal: null })
      child.emit('close', 0, null)
      await expect(launch.direct).resolves.toEqual({ exitCode: 0, signal: null })
      await expect(launch.owner.waitForExit()).resolves.toBe(true)
      expect(run).toHaveBeenCalledOnce()
      expect(runSync).toHaveBeenCalledOnce()
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })
})
