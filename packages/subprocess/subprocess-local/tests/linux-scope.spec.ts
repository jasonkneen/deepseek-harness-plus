import { EventEmitter } from 'node:events'
import { existsSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  launchLinuxScope,
  prepareLinuxTerminalScope,
  probeLinuxBootstrap,
  probeLinuxNative,
  probeLinuxScope,
} from '../src/linux-scope.ts'
import type { LinuxScopeInternals } from '../src/linux-scope.ts'
import {
  consumeLinuxLaunchRequest,
  linuxLaunchFilesFromLocator,
  writeLinuxStartupError,
} from '../src/runner-protocol.ts'
import { SUBPROCESS_RUNNER_ENV } from '../src/runner-launch.ts'

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: childProcessMocks.execFile as unknown as typeof actual.execFile,
    spawn: childProcessMocks.spawn as typeof actual.spawn,
    spawnSync: childProcessMocks.spawnSync as typeof actual.spawnSync,
  }
})

class FakeChild extends EventEmitter {
  pid: number | undefined = 321
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kills: NodeJS.Signals[] = []

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal)
    return true
  }

  exit(exitCode: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = exitCode
    this.signalCode = signal
    this.emit('exit', exitCode, signal)
  }
}

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  childProcessMocks.execFile.mockReset()
  childProcessMocks.spawn.mockReset()
  childProcessMocks.spawnSync.mockReset()
})

function missingUnit() {
  return { status: 1, stdout: '', stderr: 'Unit dsh.scope could not be found.' }
}

function activeUnit(state = 'active') {
  return { status: 0, stdout: `${state}\n`, stderr: '' }
}

function spec() {
  return {
    argv: ['tool', 'literal arg'],
    cwd: '/target',
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 100,
    env: { TARGET: 'yes' },
  } as const
}

function launch(
  query: LinuxScopeInternals['systemctlQuery'],
  overrides: LinuxScopeInternals = {},
) {
  const child = new FakeChild()
  let options: { env?: NodeJS.ProcessEnv; cwd?: string; detached?: boolean } | undefined
  const spawn = vi.fn((_command: string, _args: readonly string[], received: typeof options) => {
    options = received
    return child
  })
  const spawnSync = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }))
  const systemctlQuery = overrides.systemctlQuery ?? query
  const result = launchLinuxScope(spec(), { TARGET: 'yes' }, {
    spawn: overrides.spawn ?? spawn as never,
    spawnSync: overrides.spawnSync ?? spawnSync as never,
    ...systemctlQuery === undefined ? {} : { systemctlQuery },
    systemdRun: overrides.systemdRun ?? '/bin/systemd-run',
    systemctl: overrides.systemctl ?? '/bin/systemctl',
    runnerInvocation: overrides.runnerInvocation ?? ['/usr/bin/node', '/runner.js'],
    ...overrides.runnerAvailable === undefined ? {} : { runnerAvailable: overrides.runnerAvailable },
    ...overrides.loadLinuxExecve === undefined ? {} : { loadLinuxExecve: overrides.loadLinuxExecve },
  })
  const requestPath = options?.env?.[SUBPROCESS_RUNNER_ENV]
  if (requestPath === undefined) throw new Error('launch did not publish a request locator')
  directories.push(linuxLaunchFilesFromLocator(requestPath).directory)
  return { child, result, requestPath, spawn, spawnSync, options }
}

describe('Linux native capability selection', () => {
  it('rechecks bootstrap and literal transient-scope support', () => {
    const spawnSync = vi.fn(() => ({ status: 0, error: undefined }))
    const runnerAvailable = vi.fn(() => true)
    const loadLinuxExecve = vi.fn(() => vi.fn() as never)
    const inputs = {
      spawnSync: spawnSync as never,
      runnerAvailable,
      runnerInvocation: ['/usr/bin/node', '/runner.js'] as [string, ...string[]],
      loadLinuxExecve,
      systemdRun: '/bin/systemd-run',
      systemctl: '/bin/systemctl',
    }
    expect(probeLinuxNative(inputs)).toBe(true)
    expect(probeLinuxNative(inputs)).toBe(true)
    expect(runnerAvailable).toHaveBeenCalledTimes(2)
    expect(loadLinuxExecve).toHaveBeenCalledTimes(2)
    expect(spawnSync).toHaveBeenCalledTimes(2)
    expect(probeLinuxBootstrap({
      ...inputs,
      loadLinuxExecve: () => { throw new Error('libc execve missing') },
    })).toBe(false)
  })

  it('reports each failed dynamic prerequisite without executing a target', () => {
    expect(probeLinuxScope({
      spawnSync: vi.fn(() => ({ status: null, error: new Error('missing') })) as never,
    })).toBe(false)
    expect(probeLinuxBootstrap({
      loadLinuxExecve: () => vi.fn() as never,
      runnerInvocation: ['/missing'],
      runnerAvailable: () => false,
    })).toBe(false)
    expect(probeLinuxBootstrap({
      loadLinuxExecve: () => vi.fn() as never,
      resolveRunnerInvocation: () => { throw new Error('runner resolution failed') },
    })).toBe(false)
  })

  it('uses the default command adapters and runner resolution', () => {
    childProcessMocks.spawnSync.mockReturnValue({ status: 0, error: undefined })
    expect(probeLinuxScope()).toBe(true)
    expect(childProcessMocks.spawnSync).toHaveBeenCalledTimes(1)
    expect(probeLinuxBootstrap({ loadLinuxExecve: () => vi.fn() as never })).toBe(true)
    expect(probeLinuxBootstrap({
      runnerInvocation: [process.execPath],
      runnerAvailable: () => true,
    })).toBe(process.platform !== 'win32')
  })
})

describe('Linux scope establishment and quiescence', () => {
  it('does not mistake pre-establishment unit absence for quiescence and rejects after cancellation', async () => {
    const { child, result, requestPath, spawnSync } = launch(async () => missingUnit())
    const waiting = result.owner.waitForExit()
    result.owner.signal('SIGTERM')
    expect(child.kills).toEqual(['SIGTERM'])
    expect(spawnSync).toHaveBeenCalledWith('/bin/systemctl', expect.arrayContaining([
      'kill', '--kill-whom=all', '--signal=SIGTERM',
    ]), expect.anything())
    const direct = expect(result.direct).rejects.toThrow('before its bootstrap consumed')
    child.exit(null, 'SIGTERM')
    await direct
    await expect(waiting).rejects.toThrow('ended before consuming its launch request')
    expect(existsSync(requestPath)).toBe(true)
    result.owner.cleanup?.()
  })

  it('accepts request consumption followed by rapid --collect unload as stopped', async () => {
    const states = [activeUnit(), missingUnit()]
    const { child, result, requestPath } = launch(async () => states.shift() ?? missingUnit())
    expect(consumeLinuxLaunchRequest(requestPath)).toEqual({ cwd: '/target', env: { TARGET: 'yes' } })
    const waiting = result.owner.waitForExit()
    child.exit(0, null)
    await expect(result.direct).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(waiting).resolves.toBeUndefined()
    result.owner.signal('SIGKILL')
    result.owner.cleanup?.()
    expect(existsSync(linuxLaunchFilesFromLocator(requestPath).directory)).toBe(false)
  })

  it('uses the scope alone after establishment and the direct range only when scope signalling fails', async () => {
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'scope signal failed' })
    const { child, result, requestPath } = launch(async () => activeUnit(), {
      spawnSync: spawnSync as never,
    })
    consumeLinuxLaunchRequest(requestPath)
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true)

    result.owner.signal('SIGTERM')
    expect(processKill).not.toHaveBeenCalled()

    result.owner.signal('SIGKILL')
    expect(processKill).toHaveBeenCalledExactlyOnceWith(-321, 'SIGKILL')
    expect(spawnSync).toHaveBeenCalledTimes(2)

    child.exit(null, 'SIGKILL')
    await expect(result.direct).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
    result.owner.cleanup?.()
  })

  it('uses manager-observed unit existence as establishment proof', async () => {
    const { child, result } = launch(async () => activeUnit('inactive'))
    await expect(result.owner.waitForExit()).resolves.toBeUndefined()
    child.exit(1, null)
    await expect(result.direct).rejects.toThrow('before its bootstrap consumed')
    result.owner.cleanup?.()
  })

  it('keeps waiting while the unit is absent and the direct launcher is still running', async () => {
    const states = [missingUnit(), activeUnit('inactive')]
    const { child, result } = launch(async () => states.shift() ?? activeUnit('inactive'))
    await expect(result.owner.waitForExit()).resolves.toBeUndefined()
    child.exit(1, null)
    await expect(result.direct).rejects.toThrow('before its bootstrap consumed')
    result.owner.cleanup?.()
  })

  it('reports child termination before request consumption to both result and wait', async () => {
    const { child, result } = launch(async () => missingUnit())
    child.exit(127, null)
    await expect(result.direct).rejects.toThrow('before its bootstrap consumed')
    await expect(result.owner.waitForExit()).rejects.toThrow('ended before consuming its launch request')
    result.owner.cleanup?.()
  })

  it('reconstructs a pre-exec startup error instead of exposing bootstrap exit 127', async () => {
    const { child, result, requestPath } = launch(async () => missingUnit())
    const files = linuxLaunchFilesFromLocator(requestPath)
    unlinkSync(requestPath)
    writeLinuxStartupError(files, {
      type: 'error',
      error: { name: 'Error', message: 'spawn tool ENOENT', code: 'ENOENT' },
    })
    child.exit(127, null)
    await expect(result.direct).rejects.toMatchObject({ code: 'ENOENT' })
    result.owner.cleanup?.()
  })

  it('retries a failed state query and rejects unknown states or failed final kills', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ status: null, stdout: '', stderr: '', error: new Error('query failed') })
      .mockResolvedValueOnce(missingUnit())
    const { result, requestPath } = launch(query)
    unlinkSync(requestPath)
    await expect(result.owner.waitForExit()).rejects.toThrow('query failed')
    await expect(result.owner.waitForExit()).resolves.toBeUndefined()
    result.owner.cleanup?.()

    const unknown = launch(async () => activeUnit('mystery'))
    await expect(unknown.result.owner.waitForExit()).rejects.toThrow('unknown ActiveState')
    unknown.result.owner.cleanup?.()

    const killFailed = launch(async () => activeUnit(), {
      spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: 'permission denied' })) as never,
    })
    killFailed.result.owner.signal('SIGKILL')
    await expect(killFailed.result.owner.waitForExit()).rejects.toThrow('could not signal')
    killFailed.result.owner.cleanup?.()
  })

  it('reports command-query failures from the default systemctl adapter', async () => {
    childProcessMocks.execFile.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
      callback(null, 'inactive\n', '')
      return new EventEmitter()
    })
    const stopped = launch(undefined)
    await expect(stopped.result.owner.waitForExit()).resolves.toBeUndefined()
    stopped.result.owner.cleanup?.()

    const queryError = Object.assign(new Error('systemctl execution failed'), { code: 'ENOENT' })
    childProcessMocks.execFile.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
      callback(queryError, '', '')
      return new EventEmitter()
    })
    const failed = launch(undefined)
    await expect(failed.result.owner.waitForExit()).rejects.toBe(queryError)
    failed.result.owner.cleanup?.()
  })

  it('keeps signal failures scoped to final kill proof and stays idempotent after stop', async () => {
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 1, stderr: 'Unit dsh.scope could not be found.' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
    const states = [activeUnit(), activeUnit('failed')]
    const launched = launch(async () => states.shift() ?? missingUnit(), {
      spawnSync: spawnSync as never,
    })
    launched.child.pid = undefined
    unlinkSync(launched.requestPath)
    launched.result.owner.signal('SIGTERM')
    launched.result.owner.signal('SIGKILL')
    launched.result.owner.signal('SIGKILL')
    launched.result.owner.signal('SIGKILL')
    await expect(launched.result.owner.waitForExit()).resolves.toBeUndefined()
    await expect(launched.result.owner.waitForExit()).resolves.toBeUndefined()
    launched.result.owner.terminateForHostExit()
    expect(spawnSync).toHaveBeenCalledTimes(4)
    launched.result.owner.cleanup?.()
  })

  it('reports unreadable manager output and a failed kill before establishment', async () => {
    const withOutput = launch(async () => ({
      status: 5, stdout: '', stderr: 'permission denied',
    }))
    await expect(withOutput.result.owner.waitForExit()).rejects.toThrow('permission denied')
    withOutput.result.owner.cleanup?.()

    const withoutOutput = launch(async () => ({ status: null, stdout: '', stderr: '' }))
    await expect(withoutOutput.result.owner.waitForExit()).rejects.toThrow('exit null')
    withoutOutput.result.owner.cleanup?.()

    const killFailed = launch(async () => missingUnit(), {
      spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: 'kill denied' })) as never,
    })
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('missing process group') })
    killFailed.result.owner.signal('SIGKILL')
    await expect(killFailed.result.owner.waitForExit()).rejects.toThrow('kill denied')
    killFailed.result.owner.cleanup?.()
  })

  it('settles direct outcomes once and reports malformed startup errors', async () => {
    const childError = launch(async () => missingUnit())
    const spawnError = new Error('systemd-run failed')
    childError.child.emit('error', spawnError)
    childError.child.exit(1, null)
    await expect(childError.result.direct).rejects.toBe(spawnError)
    childError.result.owner.cleanup?.()

    const lateError = launch(async () => missingUnit())
    consumeLinuxLaunchRequest(lateError.requestPath)
    lateError.child.exit(0, null)
    lateError.child.emit('error', new Error('late child error'))
    await expect(lateError.result.direct).resolves.toEqual({ exitCode: 0, signal: null })
    lateError.result.owner.cleanup?.()

    const malformed = launch(async () => missingUnit())
    const files = linuxLaunchFilesFromLocator(malformed.requestPath)
    unlinkSync(malformed.requestPath)
    writeFileSync(files.startupErrorPath, '{', { mode: 0o600 })
    malformed.child.exit(127, null)
    await expect(malformed.result.direct).rejects.toBeInstanceOf(SyntaxError)
    malformed.result.owner.cleanup?.()
  })

  it('does not signal a direct group before the launcher publishes a pid', async () => {
    const launched = launch(async () => activeUnit('inactive'))
    launched.child.pid = undefined
    const processKill = vi.spyOn(process, 'kill')
    launched.result.owner.signal('SIGTERM')
    expect(processKill).not.toHaveBeenCalled()
    expect(launched.child.kills).toEqual([])
    consumeLinuxLaunchRequest(launched.requestPath)
    launched.child.exit(0, null)
    await expect(launched.result.direct).resolves.toEqual({ exitCode: 0, signal: null })
    launched.result.owner.cleanup?.()
  })

  it('does not signal the direct group after the launcher exits', async () => {
    const { child, result, requestPath, spawnSync } = launch(async () => activeUnit())
    consumeLinuxLaunchRequest(requestPath)
    child.exit(0, null)
    await expect(result.direct).resolves.toEqual({ exitCode: 0, signal: null })
    const processKill = vi.spyOn(process, 'kill')

    result.owner.signal('SIGTERM')
    result.owner.terminateForHostExit()

    expect(processKill).not.toHaveBeenCalled()
    expect(child.kills).toEqual([])
    expect(spawnSync).toHaveBeenCalledTimes(2)
    result.owner.cleanup?.()
  })

  it('runs direct fallback before the exact synchronous scope kill on host exit', () => {
    const events: string[] = []
    const { child, result } = launch(async () => missingUnit(), {
      spawnSync: vi.fn(() => { events.push('scope'); return { status: 0 } }) as never,
    })
    child.kill = vi.fn(() => { events.push('direct'); return true })
    vi.spyOn(process, 'kill').mockImplementation(() => { events.push('direct'); return true })
    result.owner.terminateForHostExit()
    expect(events).toEqual(['direct', 'scope'])
    result.owner.cleanup?.()
  })
})

describe('Linux PTY bootstrap reuse', () => {
  const terminalSpec = {
    argv: ['bash', '--noprofile'],
    cwd: '/target',
    env: { TARGET: 'yes' },
    rows: 24,
    cols: 80,
    graceMs: 100,
  } as const

  it('uses the same request/bootstrap, preserves argv, and cleans after owner settlement', async () => {
    const scope = prepareLinuxTerminalScope(terminalSpec, { TARGET: 'yes' }, {
      systemdRun: '/bin/systemd-run',
      systemctl: '/bin/systemctl',
      runnerInvocation: ['/usr/bin/node', '/runner.js'],
      spawnSync: vi.fn(() => ({ status: 0 })) as never,
      systemctlQuery: async () => missingUnit(),
    })
    const requestPath = scope.env[SUBPROCESS_RUNNER_ENV]
    if (requestPath === undefined) throw new Error('missing PTY request')
    expect(scope.args.slice(-3)).toEqual(['--', 'bash', '--noprofile'])
    expect(consumeLinuxLaunchRequest(requestPath)).toEqual({ cwd: '/target', env: { TARGET: 'yes' } })
    const owner = scope.bindOwner({ running: () => false, signal: vi.fn() })
    await expect(owner.waitForExit()).resolves.toBeUndefined()
    expect(scope.resolveOutcome({ exitCode: 0, signal: null })).toEqual({ exitCode: 0, signal: null })
    scope.cleanup()
    expect(existsSync(linuxLaunchFilesFromLocator(requestPath).directory)).toBe(false)
  })

  it('surfaces PTY pre-exec errors instead of launcher outcomes', () => {
    const scope = prepareLinuxTerminalScope(terminalSpec, { TARGET: 'yes' })
    const requestPath = scope.env[SUBPROCESS_RUNNER_ENV]
    if (requestPath === undefined) throw new Error('missing PTY request')
    const files = linuxLaunchFilesFromLocator(requestPath)
    unlinkSync(requestPath)
    writeLinuxStartupError(files, {
      type: 'error', error: { name: 'Error', message: 'bad cwd', code: 'ENOENT' },
    })
    expect(() => scope.resolveOutcome({ exitCode: 127, signal: null })).toThrow('bad cwd')
    scope.cleanup()
  })

  it('uses default owner dependencies and rejects an unconsumed request', () => {
    const scope = prepareLinuxTerminalScope(terminalSpec, { TARGET: 'yes' })
    const requestPath = scope.env[SUBPROCESS_RUNNER_ENV]
    if (requestPath === undefined) throw new Error('missing PTY request')
    directories.push(linuxLaunchFilesFromLocator(requestPath).directory)
    scope.bindOwner({ running: () => true, signal: vi.fn() })
    expect(() => scope.resolveOutcome({ exitCode: 1, signal: null })).toThrow(
      'before its bootstrap consumed',
    )
    scope.cleanup()
  })
})

describe('Linux ordinary launch adapters', () => {
  it('uses the default launch dependencies without changing the target request', async () => {
    const child = new FakeChild()
    childProcessMocks.spawn.mockReturnValue(child)
    const result = launchLinuxScope(spec(), { TARGET: 'yes' })
    const call = childProcessMocks.spawn.mock.calls[0]
    const options = call?.[2] as { env?: NodeJS.ProcessEnv } | undefined
    const requestPath = options?.env?.[SUBPROCESS_RUNNER_ENV]
    if (requestPath === undefined) throw new Error('launch did not publish a request locator')
    directories.push(linuxLaunchFilesFromLocator(requestPath).directory)
    expect(call?.[0]).toBe('systemd-run')
    expect(consumeLinuxLaunchRequest(requestPath)).toEqual({ cwd: '/target', env: { TARGET: 'yes' } })
    child.exit(0, null)
    await expect(result.direct).resolves.toEqual({ exitCode: 0, signal: null })
    result.owner.cleanup?.()
  })

  it('removes the private launch directory when spawn throws synchronously', () => {
    const spawnError = new Error('synchronous spawn failure')
    let requestPath: string | undefined
    expect(() => launchLinuxScope(spec(), { TARGET: 'yes' }, {
      runnerInvocation: ['/usr/bin/node', '/runner.js'],
      spawn: vi.fn((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        requestPath = options.env?.[SUBPROCESS_RUNNER_ENV]
        throw spawnError
      }) as never,
    })).toThrow(spawnError)
    if (requestPath === undefined) throw new Error('spawn did not receive a request locator')
    expect(existsSync(linuxLaunchFilesFromLocator(requestPath).directory)).toBe(false)
  })
})
