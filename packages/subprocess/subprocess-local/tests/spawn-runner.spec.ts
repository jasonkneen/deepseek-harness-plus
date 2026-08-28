import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Win32Error } from '@deepseek-ai/dsh-win32-process'
import type { NativePtr, Win32ProcessBindings } from '@deepseek-ai/dsh-win32-process'
import {
  cleanupLinuxLaunchFiles,
  consumeLinuxLaunchRequest,
  createLinuxLaunchFiles,
  deserializeRunnerError,
  isWindowsTerminateRequest,
  linuxLaunchFilesFromLocator,
  parseWindowsRunnerResult,
  parseWindowsStartRequest,
  readLinuxStartupError,
  serializeRunnerError,
  writeLinuxStartupError,
} from '../src/runner-protocol.ts'
import {
  consumeRunnerSelection,
  parseRunnerTargetArgv,
  runnerEnvironment,
  runnerInvocationAvailable,
  runnerStdio,
  resolveWindowsExecutable,
  spawnRunnerInvocation,
  SUBPROCESS_RUNNER_ENV,
  targetEnvironment,
  validateTerminalTarget,
  WINDOWS_RUNNER_SELECTION,
} from '../src/runner-launch.ts'
import {
  reportSpawnRunnerFailure,
  runSpawnRunner,
} from '../src/spawn-runner.ts'
import type { SpawnRunnerInternals } from '../src/spawn-runner.ts'

const scratch: string[] = []

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function track<T extends { directory: string }>(files: T): T {
  scratch.push(files.directory)
  return files
}

class FakeRunnerHost extends EventEmitter {
  env: NodeJS.ProcessEnv = { [SUBPROCESS_RUNNER_ENV]: 'stale', SAFE: 'bootstrap' }
  exitCode: number | undefined
  connected = true
  directory = process.cwd()
  sent: unknown[] = []
  sendFailure: Error | undefined
  sendThrown: unknown

  cwd(): string { return this.directory }
  chdir(path: string): void { this.directory = posix.resolve(this.directory, path) }
  disconnect(): void {
    if (!this.connected) return
    this.connected = false
    this.emit('disconnect')
  }
  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    if (this.sendThrown !== undefined) throw this.sendThrown
    this.sent.push(message)
    queueMicrotask(() => { callback?.(this.sendFailure ?? null) })
    return true
  }
}

function hostArgument(host: FakeRunnerHost): Parameters<typeof runSpawnRunner>[2] {
  return host as unknown as Parameters<typeof runSpawnRunner>[2]
}

function internals(overrides: Partial<SpawnRunnerInternals> = {}): SpawnRunnerInternals {
  return {
    execve: vi.fn(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }),
    loadWin32ProcessBindings: vi.fn(() => ({} as Win32ProcessBindings)),
    spawnCurrentTokenJobProcess: vi.fn(() => ({
      pid: 123,
      process: 10n as NativePtr,
      job: 20n as NativePtr,
    })),
    closeCurrentProcessStandardStreams: vi.fn(),
    resolveWindowsExecutable: vi.fn(() => 'C:\\resolved\\tool.exe'),
    pollProcessExit: vi.fn(() => 0),
    isJobEmpty: vi.fn(() => true),
    terminateJob: vi.fn(),
    closeHandleChecked: vi.fn(),
    ...overrides,
  }
}

async function runWindows(
  host: FakeRunnerHost,
  native: SpawnRunnerInternals,
  start: unknown = { type: 'start', cwd: 'C:\\target', env: { TARGET: 'yes', dsh_subprocess_runner: 'restored' } },
): Promise<void> {
  const running = runSpawnRunner(
    WINDOWS_RUNNER_SELECTION,
    ['--', 'tool.exe', 'literal arg'],
    hostArgument(host),
    native,
  )
  host.emit('message', start)
  await running
}

describe('closed runner protocol', () => {
  it('creates, consumes, reports through, and cleans one private Linux exchange', () => {
    const files = track(createLinuxLaunchFiles({ cwd: '/target', env: { A: '1' } }))
    if (process.platform !== 'win32') {
      expect(statSync(files.directory).mode & 0o777).toBe(0o700)
      expect(statSync(files.requestPath).mode & 0o777).toBe(0o600)
    }
    expect(linuxLaunchFilesFromLocator(files.requestPath)).toEqual(files)
    expect(consumeLinuxLaunchRequest(files.requestPath)).toEqual({ cwd: '/target', env: { A: '1' } })
    expect(existsSync(files.requestPath)).toBe(false)

    const failure = Object.assign(new Error('spawn missing'), {
      name: 'SpawnError', code: 'ENOENT', errno: -2, syscall: 'spawn tool', path: 'tool', spawnargs: ['x'],
    })
    writeLinuxStartupError(files, { type: 'spawn-error', error: serializeRunnerError(failure) })
    if (process.platform !== 'win32') {
      expect(statSync(files.startupErrorPath).mode & 0o777).toBe(0o600)
    }
    const result = readLinuxStartupError(files.startupErrorPath)
    expect(result).toMatchObject({ type: 'spawn-error', error: { code: 'ENOENT', path: 'tool', spawnargs: ['x'] } })
    expect(deserializeRunnerError(result!.error)).toMatchObject({
      name: 'SpawnError', message: 'spawn missing', code: 'ENOENT', errno: -2,
    })
    writeFileSync(join(files.directory, '.startup-error.tmp'), 'incomplete')
    cleanupLinuxLaunchFiles(files)
    expect(existsSync(files.directory)).toBe(false)
  })

  it('removes the private directory when request creation fails partway through', () => {
    const isolatedTmp = mkdtempSync(join(tmpdir(), 'dsh-launch-failure-spec-'))
    vi.stubEnv('TMPDIR', isolatedTmp)
    vi.stubEnv('TMP', isolatedTmp)
    vi.stubEnv('TEMP', isolatedTmp)
    try {
      const stringify = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
        throw new Error('request serialization failed')
      })
      expect(() => createLinuxLaunchFiles({ cwd: '/target', env: {} })).toThrow('request serialization failed')
      stringify.mockRestore()
      expect(readdirSync(isolatedTmp)).toEqual([])
    } finally {
      vi.unstubAllEnvs()
      rmSync(isolatedTmp, { recursive: true, force: true })
    }
  })

  it('strictly rejects malformed Linux and Windows messages', () => {
    const files = track(createLinuxLaunchFiles({ cwd: '/ok', env: {} }))
    writeFileSync(files.requestPath, JSON.stringify({ cwd: '/ok', env: {}, extra: true }))
    expect(() => consumeLinuxLaunchRequest(files.requestPath)).toThrow('invalid Linux launch request')
    expect(() => linuxLaunchFilesFromLocator('relative.json')).toThrow('invalid Linux launch-request locator')
    expect(readLinuxStartupError(files.startupErrorPath)).toBeUndefined()
    writeFileSync(files.startupErrorPath, 'null')
    expect(() => readLinuxStartupError(files.startupErrorPath)).toThrow('invalid startup error')
    writeFileSync(files.startupErrorPath, JSON.stringify({
      type: 'unknown', error: { name: 'Error', message: 'bad' },
    }))
    expect(() => readLinuxStartupError(files.startupErrorPath)).toThrow('unknown error result')

    expect(parseWindowsStartRequest({ type: 'start', cwd: 'C:\\x', env: { A: '1' } })).toEqual({
      type: 'start', cwd: 'C:\\x', env: { A: '1' },
    })
    expect(() => parseWindowsStartRequest({ type: 'start', cwd: 'C:\\x', env: {}, extra: 1 })).toThrow()
    expect(isWindowsTerminateRequest({ type: 'terminate' })).toBe(true)
    expect(isWindowsTerminateRequest({ type: 'terminate', reason: 'no' })).toBe(false)
    expect(parseWindowsRunnerResult({ type: 'start-cancelled' })).toEqual({ type: 'start-cancelled' })
    expect(parseWindowsRunnerResult({ type: 'target-exit', exitCode: null, signal: 'SIGTERM' })).toEqual({
      type: 'target-exit', exitCode: null, signal: 'SIGTERM',
    })
    expect(parseWindowsRunnerResult({ type: 'spawn-error', error: { name: 'Error', message: 'bad' } })).toEqual({
      type: 'spawn-error', error: { name: 'Error', message: 'bad' },
    })
    for (const invalid of [
      null,
      { type: 'unknown' },
      { type: 'start-cancelled', payload: 1 },
      { type: 'target-exit', exitCode: -1, signal: null },
      { type: 'target-exit', exitCode: 0, signal: 'NOPE' },
      { type: 'runner-error', error: { name: 'Error', message: 'bad', cause: {} } },
    ]) expect(() => parseWindowsRunnerResult(invalid)).toThrow()
  })

  it('contains cleanup failures and removes a substituted symlink only', () => {
    const files = track(createLinuxLaunchFiles({ cwd: '/ok', env: {} }))
    cleanupLinuxLaunchFiles(files)
    cleanupLinuxLaunchFiles(files)

    const target = join(tmpdir(), `dsh-runner-cleanup-target-${String(process.pid)}`)
    const link = join(tmpdir(), `dsh-runner-cleanup-link-${String(process.pid)}`)
    scratch.push(target, link)
    mkdirSync(target, { recursive: true })
    symlinkSync(target, link)
    cleanupLinuxLaunchFiles({
      directory: link,
      requestPath: join(link, 'launch-request.json'),
      startupErrorPath: join(link, 'startup-error.json'),
    })
    expect(existsSync(link)).toBe(false)
    expect(existsSync(target)).toBe(true)

    const blocked = track(createLinuxLaunchFiles({ cwd: '/ok', env: {} }))
    unlinkSync(blocked.requestPath)
    mkdirSync(blocked.requestPath)
    cleanupLinuxLaunchFiles(blocked)
    expect(existsSync(blocked.directory)).toBe(true)
  })
})

describe('runner launch inputs', () => {
  const spec = {
    argv: ['node', 'a'],
    cwd: process.cwd(),
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    graceMs: 100,
    env: { EXPLICIT: 'yes' },
  } as const

  it('keeps target state out of the bootstrap environment and consumes its selector', () => {
    const env = runnerEnvironment('/tmp/request')
    expect(env[SUBPROCESS_RUNNER_ENV]).toBe('/tmp/request')
    expect(env.SYSTEMD_LOG_TARGET).toBe('null')
    expect(env.EXPLICIT).toBeUndefined()
    expect(consumeRunnerSelection(env)).toBe('/tmp/request')
    expect(env[SUBPROCESS_RUNNER_ENV]).toBeUndefined()
    expect(consumeRunnerSelection({})).toBeUndefined()
    expect(parseRunnerTargetArgv(['--', 'node', 'a'])).toEqual(['node', 'a'])
    expect(() => parseRunnerTargetArgv(['node'])).toThrow('private -- delimiter')
    expect(runnerStdio(spec, false)).toEqual(['pipe', 'pipe', 'inherit'])
    expect(runnerStdio(spec, true)).toEqual(['pipe', 'pipe', 'inherit', 'ipc'])
    expect(runnerStdio({
      ...spec,
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'pipe' },
    }, false)).toEqual(['ignore', 'inherit', 'pipe'])
  })

  it('validates every Node-baseline NUL location before launch', () => {
    expect(targetEnvironment(spec)).toMatchObject({ EXPLICIT: 'yes' })
    expect(validateTerminalTarget({ ...spec, rows: 24, cols: 80 })).toMatchObject({ EXPLICIT: 'yes' })
    for (const invalid of [
      { ...spec, argv: ['node\0'] },
      { ...spec, argv: ['node', 'a\0'] },
      { ...spec, cwd: 'bad\0cwd' },
      { ...spec, env: { 'BAD\0KEY': 'x' } },
      { ...spec, env: { BAD: 'x\0' } },
    ]) {
      try {
        targetEnvironment(invalid)
        throw new Error('expected targetEnvironment to reject')
      } catch (error) {
        expect(error).toMatchObject({ name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE' })
      }
    }
  })

  it('resolves the source runner entry and checks concrete paths without executing it', () => {
    const invocation = spawnRunnerInvocation()
    expect(invocation[0]).toBe(process.execPath)
    expect(invocation).toContain('tsx/esm')
    expect(runnerInvocationAvailable(invocation)).toBe(true)
    expect(runnerInvocationAvailable(['/definitely/missing-dsh-runner'])).toBe(false)
    expect(runnerInvocationAvailable(['node'])).toBe(true)
    expect(runnerInvocationAvailable(['node', 'runner.js'])).toBe(true)

    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    try {
      expect(spawnRunnerInvocation()).toEqual([process.execPath])
    } finally {
      Reflect.deleteProperty(process, 'pkg')
    }
  })

  it('bounds non-Error and stackless runner failures', () => {
    expect(serializeRunnerError('plain failure')).toMatchObject({
      name: 'Error', message: 'plain failure',
    })
    const stackless = new Error('stackless')
    Reflect.deleteProperty(stackless, 'stack')
    expect(serializeRunnerError(stackless)).toEqual({ name: 'Error', message: 'stackless' })
    const minimal = deserializeRunnerError({ name: 'Error', message: 'minimal' })
    expect(minimal).toMatchObject({ name: 'Error', message: 'minimal' })
    expect(minimal).not.toHaveProperty('code')
    expect(minimal).not.toHaveProperty('errno')
    expect(minimal).not.toHaveProperty('syscall')
    expect(minimal).not.toHaveProperty('path')
    expect(minimal).not.toHaveProperty('spawnargs')
  })

  it('resolves Windows executables with target-cwd and PATH search semantics', () => {
    const probed: string[] = []
    const exists = (candidate: string): boolean => {
      probed.push(candidate)
      return candidate === 'C:\\tools\\git\\bin\\bash.exe'
    }
    expect(resolveWindowsExecutable('bash', 'C:\\target', {
      Path: 'relative;"C:\\semi;colon";"C:\\tools\\git\\bin";C:\\later',
    }, exists)).toBe('C:\\tools\\git\\bin\\bash.exe')
    expect(probed).toEqual([
      'C:\\target\\bash.com',
      'C:\\target\\bash.exe',
      'C:\\target\\relative\\bash.com',
      'C:\\target\\relative\\bash.exe',
      'C:\\semi;colon\\bash.com',
      'C:\\semi;colon\\bash.exe',
      'C:\\tools\\git\\bin\\bash.com',
      'C:\\tools\\git\\bin\\bash.exe',
    ])

    expect(resolveWindowsExecutable('local.exe', 'C:\\target', {}, candidate =>
      candidate === 'C:\\target\\local.exe')).toBe('C:\\target\\local.exe')
    expect(resolveWindowsExecutable('tool', 'C:\\target', {
      PATH: 'C:\\bin',
    }, candidate => candidate === 'C:\\bin\\tool.com', {
      NoDefaultCurrentDirectoryInExePath: '1',
    })).toBe('C:\\bin\\tool.com')
    expect(resolveWindowsExecutable('tool', 'C:\\target', {
      PATH: 'D:relative',
    }, candidate => candidate === 'D:relative\\tool.exe')).toBe('D:relative\\tool.exe')
    expect(resolveWindowsExecutable('tool.', 'C:\\target', {}, candidate =>
      candidate === 'C:\\target\\tool.exe')).toBe('C:\\target\\tool.exe')
    expect(resolveWindowsExecutable('.\\missing', 'C:\\target', {}, () => false))
      .toBe('C:\\target\\.\\missing')

    expect(resolveWindowsExecutable('tool', 'C:\\target', {
      PATH: ';;C:\\bin',
    }, candidate => candidate === 'C:\\bin\\tool.exe')).toBe('C:\\bin\\tool.exe')
    expect(resolveWindowsExecutable('tool', 'C:\\target', {
      PATH: '"";C:\\bin',
    }, candidate => candidate === 'C:\\bin\\tool.exe')).toBe('C:\\bin\\tool.exe')
    expect(resolveWindowsExecutable('tool', 'C:\\target', {
      PATH: '"unterminated',
    }, candidate => candidate === 'C:\\target\\unterminated\\tool.exe'))
      .toBe('C:\\target\\unterminated\\tool.exe')
    expect(resolveWindowsExecutable('\\\\server\\share\\tool', 'C:\\target', {}, candidate =>
      candidate === '\\\\server\\share\\tool.exe')).toBe('\\\\server\\share\\tool.exe')
    expect(resolveWindowsExecutable('\\tools\\tool', 'C:\\target', {}, candidate =>
      candidate === 'C:\\tools\\tool.exe')).toBe('C:\\tools\\tool.exe')
    expect(resolveWindowsExecutable('C:tools\\tool', 'C:\\target', {}, candidate =>
      candidate === 'C:\\target\\tools\\tool.exe')).toBe('C:\\target\\tools\\tool.exe')

    const noSearchEnvironment = { NoDefaultCurrentDirectoryInExePath: '1' }
    expect(resolveWindowsExecutable('missing', 'C:\\target', {}, () => false, noSearchEnvironment))
      .toBe('C:\\target\\missing.exe')
    expect(resolveWindowsExecutable('missing.cmd', 'C:\\target', {}, () => false, noSearchEnvironment))
      .toBe('C:\\target\\missing.cmd')

    const directory = mkdtempSync(join(tmpdir(), 'dsh-windows-resolver-'))
    scratch.push(directory)
    const executable = join(directory, 'direct.exe')
    const directoryCandidate = join(directory, 'directory')
    const missingExecutable = join(directory, 'missing.exe')
    writeFileSync(executable, '')
    mkdirSync(`${directoryCandidate}.com`)
    writeFileSync(`${directoryCandidate}.exe`, '')
    expect(resolveWindowsExecutable(executable, '', {})).toBe(executable)
    expect(resolveWindowsExecutable(directoryCandidate, '', {})).toBe(`${directoryCandidate}.exe`)
    expect(resolveWindowsExecutable(missingExecutable, '', {})).toBe(missingExecutable)
  })
})

describe('Linux one-shot exec bootstrap', () => {
  it('uses final cwd/env PATH while preserving the original argv', async () => {
    const files = track(createLinuxLaunchFiles({
      cwd: '/final/work',
      env: { PATH: 'relative::/absolute', [SUBPROCESS_RUNNER_ENV]: 'target-value' },
    }))
    const host = new FakeRunnerHost()
    const execve = vi.fn((_file: string, _argv: string[], _env: Record<string, string>) => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    })
    await runSpawnRunner(files.requestPath, ['--', 'tool', 'literal arg'], hostArgument(host), internals({ execve }))
    expect(host.directory).toBe('/final/work')
    expect(host.env[SUBPROCESS_RUNNER_ENV]).toBeUndefined()
    expect(execve.mock.calls.map(call => call[0])).toEqual([
      '/final/work/relative/tool',
      '/final/work/tool',
      '/absolute/tool',
    ])
    expect(execve.mock.calls[0]?.[1]).toEqual(['tool', 'literal arg'])
    expect(execve.mock.calls[0]?.[2]).toMatchObject({ [SUBPROCESS_RUNNER_ENV]: 'target-value' })
    expect(readLinuxStartupError(files.startupErrorPath)).toMatchObject({
      type: 'spawn-error', error: { code: 'ENOENT', path: 'tool' },
    })
  })

  it('resolves relative PATH entries from the cwd after chdir', async () => {
    const files = track(createLinuxLaunchFiles({ cwd: 'work', env: { PATH: 'bin:' } }))
    const host = new FakeRunnerHost()
    host.directory = '/base'
    const execve = vi.fn(() => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }) })
    await runSpawnRunner(files.requestPath, ['--', 'tool'], hostArgument(host), internals({ execve }))
    expect(host.directory).toBe('/base/work')
    expect(execve.mock.calls.map(call => call[0])).toEqual([
      '/base/work/bin/tool',
      '/base/work/tool',
    ])
  })

  it('retries ENOEXEC through /bin/sh with the resolved file and original arguments', async () => {
    const files = track(createLinuxLaunchFiles({ cwd: '/work', env: { PATH: 'bin' } }))
    const execve = vi.fn()
      .mockImplementationOnce(() => { throw Object.assign(new Error('exec format'), { code: 'ENOEXEC' }) })
      .mockImplementationOnce(() => { throw Object.assign(new Error('shell failed'), { code: 'EIO' }) })
    await runSpawnRunner(
      files.requestPath,
      ['--', 'tool', 'literal arg'],
      hostArgument(new FakeRunnerHost()),
      internals({ execve: execve as never }),
    )
    expect(execve.mock.calls).toEqual([
      ['/work/bin/tool', ['tool', 'literal arg'], { PATH: 'bin' }],
      ['/bin/sh', ['/bin/sh', '/work/bin/tool', 'literal arg'], { PATH: 'bin' }],
    ])
    expect(readLinuxStartupError(files.startupErrorPath)).toMatchObject({
      type: 'spawn-error', error: { code: 'EIO', path: 'tool' },
    })
  })

  it('uses the default PATH and stops on a non-search error', async () => {
    const files = track(createLinuxLaunchFiles({ cwd: '/work', env: {} }))
    const execve = vi.fn((_file: string) => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
    await runSpawnRunner(files.requestPath, ['--', 'tool'], hostArgument(new FakeRunnerHost()), internals({ execve }))
    expect(execve.mock.calls.map(call => call[0])).toEqual(['/usr/bin/tool', '/bin/tool'])
    expect(readLinuxStartupError(files.startupErrorPath)).toMatchObject({ type: 'spawn-error', error: { code: 'EACCES' } })

    const explicit = track(createLinuxLaunchFiles({ cwd: '/work', env: {} }))
    const fatal = vi.fn(() => { throw Object.assign(new Error('bad executable'), { code: 'EIO' }) })
    await runSpawnRunner(explicit.requestPath, ['--', './tool'], hostArgument(new FakeRunnerHost()), internals({ execve: fatal }))
    expect(fatal).toHaveBeenCalledOnce()

    const stackless = track(createLinuxLaunchFiles({ cwd: '/work', env: {} }))
    await runSpawnRunner(stackless.requestPath, ['--', './tool'], hostArgument(new FakeRunnerHost()), internals({
      execve: vi.fn(() => { throw new Error('unclassified failure') }),
    }))
    expect(readLinuxStartupError(stackless.startupErrorPath)).toMatchObject({
      type: 'spawn-error', error: { message: 'unclassified failure' },
    })

    const searched = track(createLinuxLaunchFiles({ cwd: '/work', env: {} }))
    const searchedExecve = vi.fn()
      .mockImplementationOnce(() => { throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }) })
      .mockImplementationOnce(() => { throw Object.assign(new Error('I/O failure'), { code: 'EIO' }) })
    await runSpawnRunner(searched.requestPath, ['--', 'tool'], hostArgument(new FakeRunnerHost()), internals({
      execve: searchedExecve as never,
    }))
    expect(readLinuxStartupError(searched.startupErrorPath)).toMatchObject({
      type: 'spawn-error', error: { code: 'EIO' },
    })
  })

  it('publishes request/protocol failures as runner errors', async () => {
    const files = track(createLinuxLaunchFiles({ cwd: '/work', env: {} }))
    writeFileSync(files.requestPath, '{')
    await runSpawnRunner(files.requestPath, ['--', 'tool'], hostArgument(new FakeRunnerHost()), internals())
    expect(readLinuxStartupError(files.startupErrorPath)).toMatchObject({ type: 'runner-error' })

    const early = track(createLinuxLaunchFiles({ cwd: '/work', env: {} }))
    await reportSpawnRunnerFailure(early.requestPath, new Error('delimiter failed'), hostArgument(new FakeRunnerHost()))
    expect(readLinuxStartupError(early.startupErrorPath)).toMatchObject({
      type: 'runner-error', error: { message: 'delimiter failed' },
    })
  })
})

describe('Windows Job runner protocol owner', () => {
  it('maps the bounded Win32 process-creation error classes', async () => {
    for (const [win32Code, code] of [
      [3, 'ENOENT'],
      [267, 'ENOENT'],
      [5, 'EACCES'],
      [193, 'EFTYPE'],
      [999, 'UNKNOWN'],
    ] as const) {
      const host = new FakeRunnerHost()
      await runWindows(host, internals({
        spawnCurrentTokenJobProcess: vi.fn(() => { throw new Win32Error('CreateProcessW', win32Code) }),
      }))
      expect(host.sent).toMatchObject([{ type: 'spawn-error', error: { code } }])
    }
  })

  it('rejects a Windows runner without an initial IPC channel', async () => {
    const disconnected = new FakeRunnerHost()
    disconnected.connected = false
    await runSpawnRunner(
      WINDOWS_RUNNER_SELECTION,
      ['--', 'tool.exe'],
      hostArgument(disconnected),
      internals(),
    )
    expect(disconnected.exitCode).toBe(127)

    const missingSend = new FakeRunnerHost()
    Object.defineProperty(missingSend, 'send', { value: undefined })
    await runSpawnRunner(
      WINDOWS_RUNNER_SELECTION,
      ['--', 'tool.exe'],
      hostArgument(missingSend),
      internals(),
    )
    expect(missingSend.exitCode).toBe(127)
  })

  it('sends target-exit only after suspended Job launch and closes runner stdio', async () => {
    const host = new FakeRunnerHost()
    const native = internals()
    await runWindows(host, native)
    expect(native.resolveWindowsExecutable).toHaveBeenCalledWith(
      'tool.exe',
      'C:\\target',
      { TARGET: 'yes', dsh_subprocess_runner: 'restored' },
      undefined,
      { SAFE: 'bootstrap' },
    )
    expect(native.spawnCurrentTokenJobProcess).toHaveBeenCalledWith(expect.anything(), {
      command: 'tool.exe', applicationName: 'C:\\resolved\\tool.exe', args: ['literal arg'], cwd: 'C:\\target',
    })
    expect(native.closeCurrentProcessStandardStreams).toHaveBeenCalledTimes(1)
    expect(native.closeCurrentProcessStandardStreams).toHaveBeenCalledWith(expect.anything())
    expect(native.closeHandleChecked).toHaveBeenCalledWith(expect.anything(), 10n, 'ordinary direct process')
    expect(native.closeHandleChecked).toHaveBeenCalledWith(expect.anything(), 20n, 'ordinary process Job')
    expect(host.sent).toEqual([{ type: 'target-exit', exitCode: 0, signal: null }])
    expect(host.exitCode).toBe(0)
    expect(host.env).toEqual({ TARGET: 'yes', dsh_subprocess_runner: 'restored' })
  })

  it('lets asynchronous runner stdio close before the first Windows poll', async () => {
    let tick: (() => void) | undefined
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback: () => void) => {
      tick = callback
      return 1 as unknown as ReturnType<typeof setInterval>
    })
    try {
      const events: string[] = []
      let closeComplete = false
      const host = new FakeRunnerHost()
      const native = internals({
        closeCurrentProcessStandardStreams: vi.fn(() => {
          events.push('close-start')
          queueMicrotask(() => {
            closeComplete = true
            events.push('close-complete')
            tick?.()
          })
        }),
        pollProcessExit: vi.fn(() => {
          events.push(`poll:${String(closeComplete)}`)
          return 0
        }),
      })
      await runWindows(host, native)
      expect(events).toEqual(['close-start', 'close-complete', 'poll:true'])
      expect(host.sent).toEqual([{ type: 'target-exit', exitCode: 0, signal: null }])
      expect(host.exitCode).toBe(0)
    } finally {
      interval.mockRestore()
    }
  })

  it('exhausts spawn-error, runner-error, and payload-free start-cancelled', async () => {
    const spawnHost = new FakeRunnerHost()
    await runWindows(spawnHost, internals({
      spawnCurrentTokenJobProcess: vi.fn(() => { throw new Win32Error('CreateProcessW', 2) }),
    }))
    expect(spawnHost.sent).toMatchObject([{ type: 'spawn-error', error: { code: 'ENOENT', path: 'tool.exe' } }])
    expect(spawnHost.exitCode).toBe(0)

    const runnerHost = new FakeRunnerHost()
    await runWindows(runnerHost, internals({
      loadWin32ProcessBindings: vi.fn(() => { throw new Error('binding failed') }),
    }))
    expect(runnerHost.sent).toMatchObject([{ type: 'runner-error', error: { message: 'binding failed' } }])
    expect(runnerHost.exitCode).toBe(127)

    const cancelledHost = new FakeRunnerHost()
    const native = internals()
    const running = runSpawnRunner(WINDOWS_RUNNER_SELECTION, ['--', 'tool.exe'], hostArgument(cancelledHost), native)
    cancelledHost.emit('message', { type: 'terminate' })
    cancelledHost.emit('message', { type: 'start', cwd: 'C:\\target', env: {} })
    await running
    expect(cancelledHost.sent).toEqual([{ type: 'start-cancelled' }])
    expect(native.spawnCurrentTokenJobProcess).not.toHaveBeenCalled()
  })

  it('cancels after accepting start but before target commit', async () => {
    const host = new FakeRunnerHost()
    const native = internals()
    const running = runSpawnRunner(WINDOWS_RUNNER_SELECTION, ['--', 'tool.exe'], hostArgument(host), native)
    host.emit('message', { type: 'start', cwd: 'C:\\target', env: {} })
    host.emit('message', { type: 'terminate' })
    await running
    expect(host.sent).toEqual([{ type: 'start-cancelled' }])
    expect(native.spawnCurrentTokenJobProcess).not.toHaveBeenCalled()
  })

  it('does not create a target after pre-commit IPC disconnect', async () => {
    const host = new FakeRunnerHost()
    const native = internals()
    const running = runSpawnRunner(WINDOWS_RUNNER_SELECTION, ['--', 'tool.exe'], hostArgument(host), native)
    host.emit('message', { type: 'start', cwd: 'C:\\target', env: {} })
    host.disconnect()
    await running
    await new Promise<void>((resolveImmediate) => { setImmediate(resolveImmediate) })
    expect(native.spawnCurrentTokenJobProcess).not.toHaveBeenCalled()
    expect(native.terminateJob).not.toHaveBeenCalled()
    expect(host.exitCode).toBe(127)
  })

  it('terminates and closes the unique Job immediately when IPC disconnects', async () => {
    const host = new FakeRunnerHost()
    const native = internals({ pollProcessExit: vi.fn(() => undefined), isJobEmpty: vi.fn(() => false) })
    const running = runSpawnRunner(WINDOWS_RUNNER_SELECTION, ['--', 'tool.exe'], hostArgument(host), native)
    host.emit('message', { type: 'start', cwd: 'C:\\target', env: {} })
    await new Promise<void>((resolveImmediate) => { setImmediate(resolveImmediate) })
    host.disconnect()
    await running
    expect(native.terminateJob).toHaveBeenCalledWith(expect.anything(), 20n, 1)
    expect(native.closeHandleChecked).toHaveBeenCalledWith(expect.anything(), 20n, 'ordinary process Job cleanup')
    expect(host.exitCode).toBe(127)
  })

  it('honors terminate after commit and treats result-send failure as infrastructure failure', async () => {
    const host = new FakeRunnerHost()
    const native = internals({ pollProcessExit: vi.fn(() => undefined), isJobEmpty: vi.fn(() => false) })
    const running = runSpawnRunner(WINDOWS_RUNNER_SELECTION, ['--', 'tool.exe'], hostArgument(host), native)
    host.emit('message', { type: 'start', cwd: 'C:\\target', env: {} })
    await new Promise<void>((resolveImmediate) => { setImmediate(resolveImmediate) })
    host.emit('message', { type: 'terminate' })
    host.emit('message', { type: 'terminate' })
    expect(native.terminateJob).toHaveBeenCalledWith(expect.anything(), 20n, 1)
    host.disconnect()
    await running

    const sendFailureHost = new FakeRunnerHost()
    sendFailureHost.sendFailure = new Error('send failed')
    const sendFailureNative = internals({ isJobEmpty: vi.fn(() => false) })
    await runWindows(sendFailureHost, sendFailureNative)
    expect(sendFailureNative.terminateJob).toHaveBeenCalledWith(expect.anything(), 20n, 1)
    expect(sendFailureNative.closeHandleChecked).toHaveBeenCalledWith(
      expect.anything(),
      20n,
      'ordinary process Job cleanup',
    )
    expect(sendFailureHost.exitCode).toBe(127)
  })

  it('handles commit-time termination reentrancy and termination failure', async () => {
    const reentrantHost = new FakeRunnerHost()
    const reentrant = internals({
      closeCurrentProcessStandardStreams: vi.fn(() => {
        reentrantHost.emit('message', { type: 'terminate' })
      }),
      pollProcessExit: vi.fn(() => undefined),
      isJobEmpty: vi.fn(() => false),
    })
    const reentrantRun = runSpawnRunner(
      WINDOWS_RUNNER_SELECTION,
      ['--', 'tool.exe'],
      hostArgument(reentrantHost),
      reentrant,
    )
    reentrantHost.emit('message', { type: 'start', cwd: 'C:\\target', env: {} })
    await new Promise<void>((resolveImmediate) => { setImmediate(resolveImmediate) })
    expect(reentrant.terminateJob).toHaveBeenCalledTimes(2)
    reentrantHost.disconnect()
    await reentrantRun

    const failedHost = new FakeRunnerHost()
    const failed = internals({
      pollProcessExit: vi.fn(() => undefined),
      isJobEmpty: vi.fn(() => false),
      terminateJob: vi.fn(() => { throw new Error('terminate Job failed') }),
    })
    const failedRun = runSpawnRunner(
      WINDOWS_RUNNER_SELECTION,
      ['--', 'tool.exe'],
      hostArgument(failedHost),
      failed,
    )
    failedHost.emit('message', { type: 'start', cwd: 'C:\\target', env: {} })
    await new Promise<void>((resolveImmediate) => { setImmediate(resolveImmediate) })
    failedHost.emit('message', { type: 'terminate' })
    await failedRun
    expect(failedHost.sent).toMatchObject([{ type: 'runner-error', error: { message: 'terminate Job failed' } }])
  })

  it('finishes when a later poll observes Job emptiness after result delivery', async () => {
    const host = new FakeRunnerHost()
    const native = internals({
      pollProcessExit: vi.fn().mockReturnValueOnce(0).mockReturnValue(undefined),
      isJobEmpty: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
    })
    const running = runSpawnRunner(
      WINDOWS_RUNNER_SELECTION,
      ['--', 'tool.exe'],
      hostArgument(host),
      native,
    )
    host.emit('message', { type: 'start', cwd: 'C:\\target', env: {} })
    await running
    expect(host.sent).toEqual([{ type: 'target-exit', exitCode: 0, signal: null }])
    expect(native.isJobEmpty).toHaveBeenCalledTimes(2)
  })

  it('contains poll failures and queued ticks after disconnect', async () => {
    const failedHost = new FakeRunnerHost()
    await runWindows(failedHost, internals({
      pollProcessExit: vi.fn(() => { throw new Error('poll failed') }),
    }))
    expect(failedHost.sent).toMatchObject([{ type: 'runner-error', error: { message: 'poll failed' } }])

    let tick: (() => void) | undefined
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback: () => void) => {
      tick = callback
      return 1 as unknown as ReturnType<typeof setInterval>
    })
    try {
      const host = new FakeRunnerHost()
      const native = internals({ pollProcessExit: vi.fn(() => undefined), isJobEmpty: vi.fn(() => false) })
      const running = runSpawnRunner(
        WINDOWS_RUNNER_SELECTION,
        ['--', 'tool.exe'],
        hostArgument(host),
        native,
      )
      host.emit('message', { type: 'start', cwd: 'C:\\target', env: {} })
      await new Promise<void>((resolveImmediate) => { setImmediate(resolveImmediate) })
      tick?.()
      host.disconnect()
      await running
      tick?.()
    } finally {
      interval.mockRestore()
    }
  })

  it('cleans a direct handle after the Job identity was already cleared', async () => {
    let tick: (() => void) | undefined
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback: () => void) => {
      tick = callback
      return 1 as unknown as ReturnType<typeof setInterval>
    })
    try {
      const host = new FakeRunnerHost()
      const native = internals({ pollProcessExit: vi.fn(() => undefined), isJobEmpty: vi.fn(() => true) })
      const running = runSpawnRunner(
        WINDOWS_RUNNER_SELECTION,
        ['--', 'tool.exe'],
        hostArgument(host),
        native,
      )
      host.emit('message', { type: 'start', cwd: 'C:\\target', env: {} })
      await new Promise<void>((resolveImmediate) => { setImmediate(resolveImmediate) })
      tick?.()
      host.emit('message', { type: 'terminate' })
      host.disconnect()
      await running
      expect(native.closeHandleChecked).toHaveBeenCalledWith(
        expect.anything(), 10n, 'ordinary direct process cleanup',
      )
    } finally {
      interval.mockRestore()
    }
  })

  it('fails closed for malformed or duplicate start messages and disconnected reporting', async () => {
    const malformed = new FakeRunnerHost()
    await runWindows(malformed, internals(), { type: 'start', cwd: 'C:\\x', env: {}, extra: true })
    expect(malformed.sent).toMatchObject([{ type: 'runner-error' }])

    const duplicate = new FakeRunnerHost()
    const native = internals({ pollProcessExit: vi.fn(() => undefined), isJobEmpty: vi.fn(() => false) })
    const running = runSpawnRunner(WINDOWS_RUNNER_SELECTION, ['--', 'tool.exe'], hostArgument(duplicate), native)
    duplicate.emit('message', { type: 'start', cwd: 'C:\\x', env: {} })
    duplicate.emit('message', { type: 'start', cwd: 'C:\\x', env: {} })
    await running
    expect(duplicate.sent).toMatchObject([{ type: 'runner-error' }])

    const raced = new FakeRunnerHost()
    const racedRun = runSpawnRunner(WINDOWS_RUNNER_SELECTION, ['--', 'tool.exe'], hostArgument(raced), internals())
    const lateMessage = raced.listeners('message')[0] as ((value: unknown) => void) | undefined
    const lateDisconnect = raced.listeners('disconnect')[0] as (() => void) | undefined
    raced.emit('message', { type: 'bad' })
    raced.emit('message', { type: 'bad' })
    await racedRun
    await Promise.resolve()
    lateMessage?.({ type: 'bad' })
    lateDisconnect?.()

    const disconnected = new FakeRunnerHost()
    disconnected.connected = false
    await reportSpawnRunnerFailure(WINDOWS_RUNNER_SELECTION, new Error('early'), hostArgument(disconnected))
    expect(disconnected.exitCode).toBe(127)

    const connected = new FakeRunnerHost()
    connected.sendThrown = new Error('synchronous send failure')
    await reportSpawnRunnerFailure(WINDOWS_RUNNER_SELECTION, new Error('early'), hostArgument(connected))
    expect(connected.exitCode).toBe(127)
    expect(connected.connected).toBe(false)

    const noSelection = new FakeRunnerHost()
    await reportSpawnRunnerFailure(undefined, new Error('no selector'), hostArgument(noSelection))
    expect(noSelection.exitCode).toBe(127)
  })
})
