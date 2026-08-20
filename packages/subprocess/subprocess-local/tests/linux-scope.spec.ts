import { spawn, spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { launchLinuxScope, probeLinuxScope } from '../src/linux-scope.ts'
import { spawnRunnerInvocation } from '../src/runner-launch.ts'

function spec(argv: string[]): SubprocessSpawnSpec {
  return {
    argv,
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    graceMs: 100,
    env: { LITERAL_VALUE: '$HOME ${UNCHANGED}' },
  }
}

describe('Linux systemd scope adapter', () => {
  it('requires a readable user manager and literal-argument systemd support', () => {
    const calls: string[][] = []
    const runSync = vi.fn((command: string, args: readonly string[]) => {
      calls.push([command, ...args])
      return { status: 0, error: undefined }
    }) as unknown as typeof spawnSync
    expect(probeLinuxScope({ spawnSync: runSync, systemdRun: 'systemd-run', systemctl: 'systemctl' })).toBe(true)
    expect(calls[1]).toContain('--expand-environment=no')

    const oldSystemd = vi.fn((command: string) => ({
      status: command === 'systemctl' ? 0 : 1,
      error: undefined,
    })) as unknown as typeof spawnSync
    expect(probeLinuxScope({ spawnSync: oldSystemd })).toBe(false)
  })

  it('keeps user argv out of systemd-run and reports the direct target outcome', async () => {
    let wrapper: ReturnType<typeof spawn> | undefined
    let systemdArgs: readonly string[] = []
    const run = vi.fn((_command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      systemdArgs = args
      const separator = args.indexOf('--')
      const command = args[separator + 1] as string
      wrapper = spawn(command, args.slice(separator + 2), options)
      return wrapper
    }) as unknown as typeof spawn
    const runSyncMock = vi.fn((command: string, args: readonly string[]) => {
      if (command === 'systemctl' && args[1] === 'show') {
        const active = wrapper?.exitCode === null && wrapper.signalCode === null
        return { status: 0, stdout: active ? 'active\n' : 'inactive\n', stderr: '', error: undefined }
      }
      return { status: 0, stdout: '', stderr: '', error: undefined }
    })
    const runSync = runSyncMock as unknown as typeof spawnSync
    const launch = launchLinuxScope(spec([process.execPath, '-e', 'process.exit(9)', 'literal $VALUE']), {
      spawn: run,
      spawnSync: runSync,
      runnerInvocation: spawnRunnerInvocation(),
    })
    await expect(launch.direct).resolves.toEqual({ exitCode: 9, signal: null })
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    const callsBeforeStaleSignal = runSyncMock.mock.calls.length
    launch.owner.signal('SIGKILL')
    expect(runSyncMock).toHaveBeenCalledTimes(callsBeforeStaleSignal)
    expect(systemdArgs).toContain('--expand-environment=no')
    expect(systemdArgs).not.toContain('literal $VALUE')
  })

  it('uses the authoritative SIGKILL scope signal when the runner cannot report after force kill', async () => {
    let wrapper: ReturnType<typeof spawn> | undefined
    const run = vi.fn((_command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const separator = args.indexOf('--')
      const command = args[separator + 1] as string
      wrapper = spawn(command, args.slice(separator + 2), { ...options, detached: true })
      return wrapper
    }) as unknown as typeof spawn
    const runSync = vi.fn((command: string, args: readonly string[]) => {
      if (command === 'systemctl' && args[1] === 'kill' && wrapper?.pid !== undefined) {
        process.kill(-wrapper.pid, 'SIGKILL')
      }
      if (command === 'systemctl' && args[1] === 'show') {
        const active = wrapper?.exitCode === null && wrapper.signalCode === null
        return { status: 0, stdout: active ? 'active\n' : 'inactive\n', stderr: '', error: undefined }
      }
      return { status: 0, stdout: '', stderr: '', error: undefined }
    }) as unknown as typeof spawnSync
    const launch = launchLinuxScope(spec([process.execPath, '-e', 'setInterval(() => {}, 1000)']), {
      spawn: run,
      spawnSync: runSync,
      runnerInvocation: spawnRunnerInvocation(),
    })
    launch.owner.signal('SIGKILL')
    await expect(launch.direct).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
  })

  it('rejects wait when the selected native owner becomes unreadable', async () => {
    const run = vi.fn((_command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const separator = args.indexOf('--')
      return spawn(args[separator + 1] as string, args.slice(separator + 2), options)
    }) as unknown as typeof spawn
    const runSync = vi.fn(() => ({
      status: 1,
      stdout: '',
      stderr: 'Failed to connect to bus',
      error: undefined,
    })) as unknown as typeof spawnSync
    const launch = launchLinuxScope(spec([process.execPath, '-e', 'process.exit(0)']), {
      spawn: run,
      spawnSync: runSync,
      runnerInvocation: spawnRunnerInvocation(),
    })
    await expect(launch.direct).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(launch.owner.waitForExit()).rejects.toThrow('Failed to connect to bus')
  })
})
