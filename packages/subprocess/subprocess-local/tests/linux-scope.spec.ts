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

function asyncQuery(runSync: typeof spawnSync) {
  return async (command: string, args: readonly string[]) => {
    const result = runSync(command, [...args], { encoding: 'utf8', timeout: 5_000 })
    return {
      status: result.status,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      ...result.error === undefined ? {} : { error: result.error },
    }
  }
}

describe.skipIf(process.platform === 'win32')('Linux systemd scope adapter', () => {
  it('requires a readable user manager and literal-argument systemd support', () => {
    const calls: string[][] = []
    const environments: Array<NodeJS.ProcessEnv | undefined> = []
    const runSync = vi.fn((command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      calls.push([command, ...args])
      environments.push(options?.env)
      return { status: 0, error: undefined }
    }) as unknown as typeof spawnSync
    const runnerInvocation = ['node-runtime', 'runner-entry.js']
    expect(probeLinuxScope({
      spawnSync: runSync,
      systemdRun: 'systemd-run',
      systemctl: 'systemctl',
      runnerInvocation,
    })).toBe(true)
    expect(calls[1]).toContain('--expand-environment=no')
    expect(calls[1]).not.toContain('--pipe')
    expect(calls[1]).not.toContain('--wait')
    const separator = calls[1]?.indexOf('--') ?? -1
    expect(calls[1]?.slice(separator + 1)).toEqual([...runnerInvocation, '--mode', 'probe-node'])
    expect(environments[0]?.LC_ALL).toBe('C')

    const oldSystemd = vi.fn((command: string) => ({
      status: command === 'systemctl' ? 0 : 1,
      error: undefined,
    })) as unknown as typeof spawnSync
    expect(probeLinuxScope({ spawnSync: oldSystemd })).toBe(false)

    const managerError = new Error('missing user manager')
    expect(probeLinuxScope({
      spawnSync: vi.fn(() => ({ error: managerError })) as unknown as typeof spawnSync,
    })).toBe(false)
    expect(probeLinuxScope({
      spawnSync: vi.fn(() => ({ status: 1, error: undefined })) as unknown as typeof spawnSync,
    })).toBe(false)

    const emptyInvocation = vi.fn() as unknown as typeof spawnSync
    expect(probeLinuxScope({ spawnSync: emptyInvocation, runnerInvocation: [] })).toBe(false)
    expect(emptyInvocation).not.toHaveBeenCalled()
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
      systemctlQuery: asyncQuery(runSync),
      runnerInvocation: spawnRunnerInvocation(),
    })
    await expect(launch.direct).resolves.toEqual({ exitCode: 9, signal: null })
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    const callsBeforeStaleSignal = runSyncMock.mock.calls.length
    launch.owner.signal('SIGKILL')
    expect(runSyncMock).toHaveBeenCalledTimes(callsBeforeStaleSignal)
    expect(systemdArgs).toContain('--expand-environment=no')
    expect(systemdArgs).not.toContain('--pipe')
    expect(systemdArgs).not.toContain('--wait')
    expect(systemdArgs).not.toContain('literal $VALUE')
  })

  it('still escalates after a missing-unit TERM response and uses the authoritative scope KILL', async () => {
    let wrapper: ReturnType<typeof spawn> | undefined
    const run = vi.fn((_command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const separator = args.indexOf('--')
      const command = args[separator + 1] as string
      wrapper = spawn(command, args.slice(separator + 2), { ...options, detached: true })
      return wrapper
    }) as unknown as typeof spawn
    const runSync = vi.fn((command: string, args: readonly string[]) => {
      if (command === 'systemctl' && args[1] === 'kill') {
        if (args.includes('--signal=SIGTERM')) {
          return { status: 1, stdout: '', stderr: 'Unit could not be found', error: undefined }
        }
        if (wrapper?.pid !== undefined) process.kill(-wrapper.pid, 'SIGKILL')
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
      systemctlQuery: asyncQuery(runSync),
      runnerInvocation: spawnRunnerInvocation(),
    })
    launch.owner.signal('SIGTERM')
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
      stderr: 'Failed to connect to bus: No such file or directory',
      error: undefined,
    })) as unknown as typeof spawnSync
    const launch = launchLinuxScope(spec([process.execPath, '-e', 'process.exit(0)']), {
      spawn: run,
      spawnSync: runSync,
      systemctlQuery: asyncQuery(runSync),
      runnerInvocation: spawnRunnerInvocation(),
    })
    await expect(launch.direct).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(launch.owner.waitForExit()).rejects.toThrow('Failed to connect to bus')
  })

  it('propagates systemctl execution failures and unknown active states', async () => {
    const run = vi.fn((_command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const separator = args.indexOf('--')
      return spawn(args[separator + 1] as string, args.slice(separator + 2), options)
    }) as unknown as typeof spawn
    const failure = new Error('systemctl execution failed')
    const failedRead = launchLinuxScope(spec([process.execPath, '-e', 'process.exit(0)']), {
      spawn: run,
      spawnSync: vi.fn(() => ({ error: failure })) as unknown as typeof spawnSync,
      systemctlQuery: async () => ({ status: null, stdout: '', stderr: '', error: failure }),
      runnerInvocation: spawnRunnerInvocation(),
    })
    await expect(failedRead.owner.waitForExit()).rejects.toBe(failure)
    await expect(failedRead.direct).resolves.toEqual({ exitCode: 0, signal: null })

    const unknownState = launchLinuxScope(spec([process.execPath, '-e', 'process.exit(0)']), {
      spawn: run,
      spawnSync: vi.fn(() => ({ status: 0, stdout: 'reloading\n', stderr: '', error: undefined })) as unknown as typeof spawnSync,
      systemctlQuery: async () => ({ status: 0, stdout: 'reloading\n', stderr: '' }),
      runnerInvocation: spawnRunnerInvocation(),
    })
    await expect(unknownState.owner.waitForExit()).rejects.toThrow('unknown ActiveState')
    await expect(unknownState.direct).resolves.toEqual({ exitCode: 0, signal: null })

    const blankFailure = launchLinuxScope(spec([process.execPath, '-e', 'process.exit(0)']), {
      spawn: run,
      spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '', error: undefined })) as unknown as typeof spawnSync,
      systemctlQuery: async () => ({ status: 1, stdout: '', stderr: '' }),
      runnerInvocation: spawnRunnerInvocation(),
    })
    await expect(blankFailure.owner.waitForExit()).rejects.toThrow('exit 1')
    await expect(blankFailure.direct).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it.each(['activating', 'deactivating', 'failed'])(
    'recognizes the %s scope state',
    async (initialState) => {
      let wrapper: ReturnType<typeof spawn> | undefined
      let reads = 0
      const run = vi.fn((_command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
        const separator = args.indexOf('--')
        wrapper = spawn(args[separator + 1] as string, args.slice(separator + 2), options)
        return wrapper
      }) as unknown as typeof spawn
      const runSync = vi.fn(() => {
        reads += 1
        return {
          status: 0,
          stdout: reads === 1 ? `${initialState}\n` : 'inactive\n',
          stderr: '',
          error: undefined,
        }
      }) as unknown as typeof spawnSync
      const launch = launchLinuxScope(spec([process.execPath, '-e', 'process.exit(0)']), {
        spawn: run,
        spawnSync: runSync,
        systemctlQuery: asyncQuery(runSync),
        runnerInvocation: spawnRunnerInvocation(),
      })
      await expect(launch.owner.waitForExit()).resolves.toBe(true)
      await expect(launch.direct).resolves.toEqual({ exitCode: 0, signal: null })
    },
  )

  it('uses runner liveness when systemd has already forgotten the scope', async () => {
    const run = vi.fn((_command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const separator = args.indexOf('--')
      return spawn(args[separator + 1] as string, args.slice(separator + 2), options)
    }) as unknown as typeof spawn
    const runSyncMock = vi.fn(() => ({
      status: 1,
      stdout: '',
      stderr: 'Unit could not be found',
      error: undefined,
    }))
    const runSync = runSyncMock as unknown as typeof spawnSync
    const launch = launchLinuxScope(spec([process.execPath, '-e', 'setTimeout(() => {}, 40)']), {
      spawn: run,
      spawnSync: runSync,
      systemctlQuery: asyncQuery(runSync),
      runnerInvocation: spawnRunnerInvocation(),
    })
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    await expect(launch.direct).resolves.toEqual({ exitCode: 0, signal: null })
    expect(runSyncMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('does not fabricate a direct outcome after a non-forced scope signal', async () => {
    let wrapper: ReturnType<typeof spawn> | undefined
    const run = vi.fn((_command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const separator = args.indexOf('--')
      wrapper = spawn(args[separator + 1] as string, args.slice(separator + 2), { ...options, detached: true })
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
      systemctlQuery: asyncQuery(runSync),
      runnerInvocation: spawnRunnerInvocation(),
    })
    launch.owner.signal('SIGTERM')
    await expect(launch.direct).rejects.toThrow('exited without a direct-command result')
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
  })

  it.each([
    [
      'execution error',
      { status: null, stdout: '', stderr: '', error: new Error('systemctl execution failed') },
      'systemctl execution failed',
    ],
    [
      'stderr',
      { status: 1, stdout: '', stderr: 'Failed to connect to bus', error: undefined },
      'Failed to connect to bus',
    ],
    [
      'exit status',
      { status: 1, stdout: '', stderr: '', error: undefined },
      'exit 1',
    ],
  ])('reports a failed scope KILL through the shared wait: %s', async (_label, failure, message) => {
    let wrapper: ReturnType<typeof spawn> | undefined
    const run = vi.fn((_command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const separator = args.indexOf('--')
      wrapper = spawn(args[separator + 1] as string, args.slice(separator + 2), options)
      return wrapper
    }) as unknown as typeof spawn
    const runSyncMock = vi.fn((
      command: string,
      args: readonly string[],
      _options?: { env?: NodeJS.ProcessEnv },
    ) => {
      if (command === 'systemctl' && args[1] === 'kill') {
        return failure
      }
      return { status: 0, stdout: 'active\n', stderr: '', error: undefined }
    })
    const runSync = runSyncMock as unknown as typeof spawnSync
    const launch = launchLinuxScope(spec([process.execPath, '-e', 'setInterval(() => {}, 1000)']), {
      spawn: run,
      spawnSync: runSync,
      systemctlQuery: asyncQuery(runSync),
      runnerInvocation: spawnRunnerInvocation(),
    })
    void launch.direct.catch(() => {})
    try {
      launch.owner.signal('SIGKILL')
      await expect(launch.owner.waitForExit()).rejects.toThrow(message)
      const killCall = runSyncMock.mock.calls.find(([, args]) => args.includes('--signal=SIGKILL'))
      expect(killCall?.[0]).toBe('systemctl')
      expect(killCall?.[1]).toContain('kill')
      expect(killCall?.[1]).toContain('--kill-whom=all')
      expect(killCall?.[2]?.env?.LC_ALL).toBe('C')
    } finally {
      wrapper?.kill('SIGKILL')
    }
  })

  it('uses the production command defaults when no Linux internals are supplied', async () => {
    let wrapper: ReturnType<typeof spawn> | undefined
    let queryFailure: (Error & { code?: string | number }) | undefined
    const run = vi.fn()
    const runSync = vi.fn()
    const runAsync = vi.fn()
    const queryEnvironments: Array<NodeJS.ProcessEnv | undefined> = []
    vi.resetModules()
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>()
      run.mockImplementation((_command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
        const separator = args.indexOf('--')
        wrapper = actual.spawn(args[separator + 1] as string, args.slice(separator + 2), options)
        return wrapper
      })
      runSync.mockImplementation((_command: string, _args: readonly string[]) => {
        return { status: 0, stdout: '', stderr: '', error: undefined }
      })
      runAsync.mockImplementation((
        _command: string,
        args: readonly string[],
        options: { env?: NodeJS.ProcessEnv },
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        queryEnvironments.push(options.env)
        if (queryFailure !== undefined) {
          callback(queryFailure, '', '')
          return
        }
        const active = wrapper?.exitCode === null && wrapper.signalCode === null
        callback(null, args[1] === 'show' && active ? 'active\n' : 'inactive\n', '')
      })
      return { ...actual, execFile: runAsync, spawn: run, spawnSync: runSync }
    })
    try {
      const defaults = await import('../src/linux-scope.ts')
      expect(defaults.probeLinuxScope()).toBe(true)
      const launch = defaults.launchLinuxScope(spec([process.execPath, '-e', 'process.exit(0)']))
      await expect(launch.direct).resolves.toEqual({ exitCode: 0, signal: null })
      await expect(launch.owner.waitForExit()).resolves.toBe(true)
      expect(run).toHaveBeenCalledWith('systemd-run', expect.any(Array), expect.any(Object))
      expect(runSync).toHaveBeenCalledWith('systemctl', expect.any(Array), expect.any(Object))
      expect(runAsync).toHaveBeenCalledWith('systemctl', expect.any(Array), expect.any(Object), expect.any(Function))
      expect(queryEnvironments[0]?.LC_ALL).toBe('C')

      queryFailure = Object.assign(new Error('numeric systemctl failure'), { code: 17 })
      const numericFailure = defaults.launchLinuxScope(spec([process.execPath, '-e', 'process.exit(0)']))
      await expect(numericFailure.owner.waitForExit()).rejects.toBe(queryFailure)
      await expect(numericFailure.direct).resolves.toEqual({ exitCode: 0, signal: null })

      queryFailure = Object.assign(new Error('named systemctl failure'), { code: 'EQUERY' })
      const namedFailure = defaults.launchLinuxScope(spec([process.execPath, '-e', 'process.exit(0)']))
      await expect(namedFailure.owner.waitForExit()).rejects.toBe(queryFailure)
      await expect(namedFailure.direct).resolves.toEqual({ exitCode: 0, signal: null })
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })
})
