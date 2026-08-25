import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  launchLinuxScope,
  prepareLinuxTerminalScope,
  probeLinuxRunner,
  probeLinuxScope,
  probeLinuxUserManager,
} from '../src/linux-scope.ts'
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
  it('separates the live manager, stable scope, and ordinary-runner probes', () => {
    const secretName = 'DSH_SCOPE_TEST_TOKEN'
    const previousSecret = process.env[secretName]
    process.env[secretName] = 'secret'
    const calls: string[][] = []
    const environments: Array<NodeJS.ProcessEnv | undefined> = []
    const runSync = vi.fn((command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      calls.push([command, ...args])
      environments.push(options?.env)
      return { status: 0, error: undefined }
    }) as unknown as typeof spawnSync
    const runnerInvocation: [string, ...string[]] = ['node-runtime', 'runner-entry.js']
    try {
      expect(probeLinuxUserManager({
        spawnSync: runSync,
        systemctl: 'systemctl',
      })).toBe(true)
      expect(probeLinuxRunner({
        spawnSync: runSync,
        runnerInvocation,
      })).toBe(true)
      expect(probeLinuxScope({
        spawnSync: runSync,
        systemdRun: 'systemd-run',
        systemctl: 'systemctl',
      })).toBe(true)
      expect(calls[0]).toEqual(['systemctl', '--user', 'show-environment'])
      expect(calls[1]).toEqual([...runnerInvocation, '--mode', 'probe-node'])
      expect(calls[2]).toContain('--expand-environment=no')
      expect(calls[2]).not.toContain('--pipe')
      expect(calls[2]).not.toContain('--wait')
      const unitArg = calls[2]?.find(arg => arg.startsWith('--unit='))
      if (unitArg === undefined) throw new Error('scope probe did not publish its unit')
      const separator = calls[2]?.indexOf('--') ?? -1
      expect(calls[2]?.slice(separator + 1)).toEqual([
        'systemctl',
        '--user',
        'show',
        `${unitArg.slice('--unit='.length)}.scope`,
        '--property=ActiveState',
        '--value',
      ])
      expect(environments[0]?.LC_ALL).toBe('C')
      for (const environment of environments) expect(environment).not.toHaveProperty(secretName)
    } finally {
      if (previousSecret === undefined) Reflect.deleteProperty(process.env, secretName)
      else process.env[secretName] = previousSecret
    }

    const oldSystemd = vi.fn(() => ({ status: 1, error: undefined })) as unknown as typeof spawnSync
    expect(probeLinuxScope({ spawnSync: oldSystemd })).toBe(false)
    expect(probeLinuxScope({
      spawnSync: vi.fn(() => ({ status: 0, error: new Error('scope failed') })) as unknown as typeof spawnSync,
    })).toBe(false)

    const failedRunner = vi.fn(() => ({ status: 1, error: undefined })) as unknown as typeof spawnSync
    expect(probeLinuxRunner({
      spawnSync: failedRunner,
      runnerInvocation: ['node-runtime', 'runner-entry.js'],
    })).toBe(false)
    expect(failedRunner).toHaveBeenCalledOnce()
    expect(probeLinuxRunner({
      spawnSync: vi.fn(() => ({ status: 0, error: new Error('runner failed') })) as unknown as typeof spawnSync,
      runnerInvocation: ['node-runtime', 'runner-entry.js'],
    })).toBe(false)

    const managerError = new Error('missing user manager')
    expect(probeLinuxUserManager({
      spawnSync: vi.fn(() => ({ error: managerError })) as unknown as typeof spawnSync,
    })).toBe(false)
    expect(probeLinuxUserManager({
      spawnSync: vi.fn(() => ({ status: 1, error: undefined })) as unknown as typeof spawnSync,
    })).toBe(false)
  })

  it('removes private runner files when systemd-run throws synchronously', () => {
    const failure = new Error('systemd-run threw')
    let requestPath: string | undefined
    const run = vi.fn((_command: string, args: readonly string[]) => {
      const requestIndex = args.indexOf('--request')
      requestPath = args[requestIndex + 1]
      throw failure
    }) as unknown as typeof spawn

    expect(() => launchLinuxScope(spec([process.execPath, '-e', '']), {
      spawn: run,
      runnerInvocation: spawnRunnerInvocation(),
    })).toThrow(failure)
    expect(requestPath).toBeDefined()
    expect(existsSync(dirname(requestPath as string))).toBe(false)
  })

  it('wraps terminal argv literally and binds signalling and observation to the same scope', async () => {
    const signalCalls: Array<[string, readonly string[]]> = []
    const queryCalls: Array<[string, readonly string[]]> = []
    const runSync = vi.fn((command: string, args: readonly string[]) => {
      signalCalls.push([command, args])
      return { status: 0, stdout: '', stderr: '', error: undefined }
    }) as unknown as typeof spawnSync
    const query = vi.fn(async (command: string, args: readonly string[]) => {
      queryCalls.push([command, args])
      return { status: 0, stdout: 'inactive\n', stderr: '' }
    })
    const argv = ['/bin/bash', '-c', 'printf "%s" "$HOME"']
    const launch = prepareLinuxTerminalScope(argv, {
      spawnSync: runSync,
      systemdRun: '/usr/bin/systemd-run',
      systemctl: '/usr/bin/systemctl',
      systemctlQuery: query,
    })
    const unitArg = launch.args.find(arg => arg.startsWith('--unit='))
    if (unitArg === undefined) throw new Error('terminal scope did not publish its unit')
    const unit = `${unitArg.slice('--unit='.length)}.scope`

    expect(launch.command).toBe('/usr/bin/systemd-run')
    expect(launch.args.slice(0, -argv.length)).toEqual([
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--expand-environment=no',
      unitArg,
      '--',
    ])
    expect(launch.args.slice(-argv.length)).toEqual(argv)

    const owner = launch.bindOwner(() => false)
    owner.signal('SIGTERM')
    owner.signal('SIGKILL')
    await owner.waitForExit()

    expect(signalCalls).toEqual([
      [
        '/usr/bin/systemctl',
        ['--user', 'kill', '--kill-whom=all', '--signal=SIGTERM', unit],
      ],
      [
        '/usr/bin/systemctl',
        ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', unit],
      ],
    ])
    expect(queryCalls).toEqual([[
      '/usr/bin/systemctl',
      ['--user', 'show', unit, '--property=ActiveState', '--value'],
    ]])
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
    await expect(launch.owner.waitForExit()).resolves.toBeUndefined()
    await expect(launch.owner.waitForExit()).resolves.toBeUndefined()
    const callsBeforeStaleSignal = runSyncMock.mock.calls.length
    launch.owner.signal('SIGKILL')
    expect(runSyncMock).toHaveBeenCalledTimes(callsBeforeStaleSignal)
    expect(systemdArgs).toContain('--expand-environment=no')
    expect(systemdArgs).not.toContain('--pipe')
    expect(systemdArgs).not.toContain('--wait')
    expect(systemdArgs).not.toContain('literal $VALUE')
  })

  it('uses a scope KILL after the owner proves the range empty', async () => {
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
        return {
          status: 1,
          stdout: '',
          stderr: 'Failed to send signal SIGKILL to auxiliary processes: Invalid argument',
          error: undefined,
        }
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
    await expect(launch.owner.waitForExit()).resolves.toBeUndefined()
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
      await expect(launch.owner.waitForExit()).resolves.toBeUndefined()
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
    await expect(launch.owner.waitForExit()).resolves.toBeUndefined()
    await expect(launch.direct).resolves.toEqual({ exitCode: 0, signal: null })
    expect(runSyncMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('settles a missing scope immediately when the wrapper never started', async () => {
    const launch = launchLinuxScope(spec([process.execPath, '-e', '']), {
      systemdRun: `missing-systemd-run-${String(process.pid)}-${String(Date.now())}`,
      systemctlQuery: async () => ({
        status: 1,
        stdout: '',
        stderr: 'Unit dsh-subprocess-missing.scope could not be found',
      }),
      runnerInvocation: spawnRunnerInvocation(),
    })
    expect(launch.pid).toBeUndefined()
    await expect(launch.direct).rejects.toThrow('runner failed to start')
    await expect(launch.owner.waitForExit()).resolves.toBeUndefined()
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
    await expect(launch.owner.waitForExit()).resolves.toBeUndefined()
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
      expect(defaults.probeLinuxUserManager()).toBe(true)
      expect(defaults.probeLinuxRunner()).toBe(true)
      expect(defaults.probeLinuxScope()).toBe(true)
      const terminalLaunch = defaults.prepareLinuxTerminalScope(['shell', 'literal $HOME'])
      expect(terminalLaunch.command).toBe('systemd-run')
      expect(terminalLaunch.args.slice(-3)).toEqual(['--', 'shell', 'literal $HOME'])
      const launch = defaults.launchLinuxScope(spec([process.execPath, '-e', 'process.exit(0)']))
      await expect(launch.direct).resolves.toEqual({ exitCode: 0, signal: null })
      await expect(launch.owner.waitForExit()).resolves.toBeUndefined()
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
