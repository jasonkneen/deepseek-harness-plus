import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { Win32Error } from '@deepseek-ai/dsh-win32-process'
import type { NativePtr, Win32ProcessBindings } from '@deepseek-ai/dsh-win32-process'
import {
  cleanupAfterRunner,
  runnerDirectResult,
  runnerFiles,
  runnerStdio,
  spawnRunnerInvocation,
} from '../src/runner-launch.ts'
import { observeChildLifecycle } from '../src/managed-owner.ts'
import {
  appendRunnerEvent,
  cleanupRunnerFiles,
  consumeRunnerRequest,
  createRunnerFiles,
  deserializeSpawnError,
  readRunnerEvents,
  readRunnerEventsAsync,
  serializeSpawnError,
} from '../src/runner-protocol.ts'
import { reportSpawnRunnerFailure, runSpawnRunner } from '../src/spawn-runner.ts'

const sourceInvocation = [
  process.execPath,
  '--import',
  'tsx/esm',
  fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/src/bin.ts')),
]
function spec(overrides: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec {
  return {
    argv: [process.execPath, '-e', ''],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    graceMs: 100,
    ...overrides,
  }
}

function fakeChild(pid: number | undefined): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { pid, exitCode: null, signalCode: null })
  return child
}

class FakeRunnerHost extends EventEmitter {
  env: NodeJS.ProcessEnv = {}
  exitCode: number | undefined
  connected = false
  directory = process.cwd()
  readonly disconnect = vi.fn(() => { this.connected = false })

  cwd(): string { return this.directory }
  chdir(directory: string): void { this.directory = directory }
}

function asRunnerHost(host: FakeRunnerHost): Parameters<typeof runSpawnRunner>[1] {
  return host as unknown as Parameters<typeof runSpawnRunner>[1]
}

type RunnerInternals = NonNullable<Parameters<typeof runSpawnRunner>[2]>

const fakeWin32Api = {} as Win32ProcessBindings
const fakeProcessHandle = 60n as NativePtr
const fakeJobHandle = 50n as NativePtr

function fakeRunnerInternals(overrides: Partial<RunnerInternals> = {}): RunnerInternals {
  let nextPipeHandle = 70n
  return {
    spawn,
    loadWin32ProcessBindings: vi.fn(() => fakeWin32Api),
    openNamedPipeForStdio: vi.fn(() => nextPipeHandle++),
    spawnCurrentTokenJobProcess: vi.fn(() => ({
      pid: 1234,
      process: fakeProcessHandle,
      job: fakeJobHandle,
    })),
    pollProcessExit: vi.fn(() => 0),
    isJobEmpty: vi.fn(() => true),
    terminateJob: vi.fn(),
    waitForProcessExit: vi.fn(() => 0),
    closeHandleChecked: vi.fn(),
    ...overrides,
  } as RunnerInternals
}

function win32RunnerArgs(
  requestPath: string,
  eventsPath: string,
  pipes: string[] = [],
): string[] {
  return [
    '--mode', 'win32',
    '--request', requestPath,
    '--events', eventsPath,
    ...pipes,
  ]
}

function runRunner(invocation: string[], requestPath: string, eventsPath: string) {
  const [command, ...prefix] = invocation
  return spawnSync(command as string, [
    ...prefix,
    '--mode',
    'node',
    '--request',
    requestPath,
    '--events',
    eventsPath,
  ], { encoding: 'utf8', timeout: 10_000 })
}

describe('spawn runner transport', () => {
  it('selects the source runner without publishing a runner package face', () => {
    expect(spawnRunnerInvocation()).toEqual(sourceInvocation)
    const manifest = JSON.parse(readFileSync(
      fileURLToPath(new URL('../package.json', import.meta.url)),
      'utf8',
    )) as { exports: Record<string, unknown> }
    expect(manifest.exports).not.toHaveProperty('./spawn-runner')
    expect(manifest.exports['./package.json']).toBe('./package.json')
  })

  it('observes runner events without SharedArrayBuffer', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer')
    Object.defineProperty(globalThis, 'SharedArrayBuffer', { configurable: true, value: undefined })
    vi.resetModules()
    const files = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      const isolated = await import('../src/runner-launch.ts')
      const result = isolated.runnerDirectResult(fakeChild(123), files, new Promise<void>(() => {}))
      appendRunnerEvent(files.eventsPath, { type: 'started', pid: 456 })
      appendRunnerEvent(files.eventsPath, { type: 'exit', exitCode: 0, signal: null })
      await expect(result.direct).resolves.toEqual({ exitCode: 0, signal: null })
      expect(result.pid).toBe(456)
    } finally {
      cleanupRunnerFiles(files)
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'SharedArrayBuffer')
      else Object.defineProperty(globalThis, 'SharedArrayBuffer', descriptor)
      vi.resetModules()
    }
  })

  it('re-enters a packaged executable through its private runner dispatch', () => {
    const packagedProcess = process as NodeJS.Process & { pkg?: unknown }
    const original = Object.getOwnPropertyDescriptor(packagedProcess, 'pkg')
    Object.defineProperty(packagedProcess, 'pkg', { configurable: true, value: {} })
    try {
      expect(spawnRunnerInvocation()).toEqual([process.execPath, '--dsh-internal-subprocess-runner'])
    } finally {
      if (original === undefined) Reflect.deleteProperty(packagedProcess, 'pkg')
      else Object.defineProperty(packagedProcess, 'pkg', original)
    }
  })

  it('supports the node runner capability probe', () => {
    const result = spawnSync(sourceInvocation[0] as string, [
      ...sourceInvocation.slice(1),
      '--mode',
      'probe-node',
    ], { encoding: 'utf8', timeout: 10_000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
  })

  it('runs the Node target lifecycle in-process through the coverable runner logic', async () => {
    const files = createRunnerFiles({
      argv: [process.execPath, '-e', 'process.exit(12)'],
      cwd: process.cwd(),
      env: {},
    })
    const host = new FakeRunnerHost()
    try {
      await runSpawnRunner([
        '--mode', 'node',
        '--request', files.requestPath,
        '--events', files.eventsPath,
      ], asRunnerHost(host))
      expect(host.exitCode).toBe(12)
      expect(readRunnerEvents(files.eventsPath)).toEqual([
        expect.objectContaining({ type: 'started' }),
        { type: 'exit', exitCode: 12, signal: null },
      ])
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('reports an in-process Node target spawn failure', async () => {
    const files = createRunnerFiles({
      argv: [`missing-dsh-runner-target-${String(process.pid)}-${String(Date.now())}`],
      cwd: process.cwd(),
      env: {},
    })
    const host = new FakeRunnerHost()
    try {
      await runSpawnRunner([
        '--mode', 'node',
        '--request', files.requestPath,
        '--events', files.eventsPath,
      ], asRunnerHost(host))
      expect(host.exitCode).toBe(127)
      const [event] = readRunnerEvents(files.eventsPath)
      expect(event?.type).toBe('spawn-error')
      if (event?.type !== 'spawn-error') throw new Error('expected spawn error')
      expect(event.error.code).toBe('ENOENT')
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('contains a post-start Node runner error and ignores scope signals', async () => {
    const files = createRunnerFiles({ argv: ['node'], cwd: process.cwd(), env: {} })
    const host = new FakeRunnerHost()
    const child = Object.assign(new EventEmitter(), { pid: 4321 }) as ChildProcess
    const injectedSpawn = vi.fn(() => {
      queueMicrotask(() => {
        host.emit('SIGTERM')
        child.emit('spawn')
        child.emit('error', new Error('post-start node failure'))
        child.emit('exit', 0, null)
      })
      return child
    }) as unknown as typeof spawn
    try {
      await runSpawnRunner([
        '--mode', 'node',
        '--request', files.requestPath,
        '--events', files.eventsPath,
      ], asRunnerHost(host), fakeRunnerInternals({ spawn: injectedSpawn }))
      expect(injectedSpawn).toHaveBeenCalledTimes(1)
      expect(injectedSpawn).toHaveBeenCalledWith('node', [], {
        cwd: process.cwd(),
        env: {},
        stdio: 'inherit',
        detached: true,
      })
      expect(host.exitCode).toBe(127)
      expect(readRunnerEvents(files.eventsPath)).toEqual([
        { type: 'started', pid: 4321 },
        { type: 'runner-error', error: { name: 'Error', message: 'post-start node failure' } },
      ])
      expect(host.listenerCount('SIGTERM')).toBe(0)
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('maps a signal-only Node exit to the runner failure exit code', async () => {
    const files = createRunnerFiles({ argv: ['node'], cwd: process.cwd(), env: {} })
    const host = new FakeRunnerHost()
    const child = Object.assign(new EventEmitter(), { pid: 4321 }) as ChildProcess
    const injectedSpawn = vi.fn(() => {
      queueMicrotask(() => {
        child.emit('spawn')
        child.emit('exit', null, 'SIGTERM')
      })
      return child
    }) as unknown as typeof spawn
    try {
      await runSpawnRunner([
        '--mode', 'node',
        '--request', files.requestPath,
        '--events', files.eventsPath,
      ], asRunnerHost(host), fakeRunnerInternals({ spawn: injectedSpawn }))
      expect(host.exitCode).toBe(1)
      expect(readRunnerEvents(files.eventsPath)).toEqual([
        { type: 'started', pid: 4321 },
        { type: 'exit', exitCode: null, signal: 'SIGTERM' },
      ])
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('runs the in-process capability probes and always closes the probe Job', async () => {
    const nodeHost = new FakeRunnerHost()
    await expect(runSpawnRunner(
      ['--mode', 'probe-node'],
      asRunnerHost(nodeHost),
      fakeRunnerInternals(),
    )).resolves.toBeUndefined()

    const host = new FakeRunnerHost()
    host.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    host.directory = 'C:\\runner'
    const internals = fakeRunnerInternals()
    await expect(runSpawnRunner(
      ['--mode', 'probe-win32'],
      asRunnerHost(host),
      internals,
    )).resolves.toBeUndefined()
    expect(internals.spawnCurrentTokenJobProcess).toHaveBeenCalledWith(fakeWin32Api, {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'exit 0'],
      cwd: 'C:\\runner',
    })
    expect(internals.waitForProcessExit).toHaveBeenCalledWith(fakeWin32Api, fakeProcessHandle)
    expect(internals.closeHandleChecked).toHaveBeenCalledWith(
      fakeWin32Api,
      fakeJobHandle,
      'subprocess Windows Job probe',
    )

    const legacyHost = new FakeRunnerHost()
    legacyHost.env.COMSPEC = 'legacy-cmd.exe'
    const failing = fakeRunnerInternals({ waitForProcessExit: vi.fn(() => 9) })
    await expect(runSpawnRunner(
      ['--mode', 'probe-win32'],
      asRunnerHost(legacyHost),
      failing,
    )).rejects.toThrow('probe exited with code 9')
    expect(failing.closeHandleChecked).toHaveBeenCalledWith(
      fakeWin32Api,
      fakeJobHandle,
      'subprocess Windows Job probe',
    )

    await expect(runSpawnRunner(
      ['--mode', 'probe-win32'],
      asRunnerHost(new FakeRunnerHost()),
      fakeRunnerInternals(),
    )).rejects.toThrow('without ComSpec')
  })

  it('runs the Win32 target, forwards every pipe, and waits for an empty Job', async () => {
    vi.useFakeTimers()
    const files = createRunnerFiles({
      argv: ['tool.exe', 'literal $HOME'],
      cwd: 'C:\\target',
      env: { ONLY: 'kept' },
    })
    const host = new FakeRunnerHost()
    host.env.STALE = 'removed'
    host.directory = 'C:\\runner'
    host.connected = true
    const pollProcessExit = vi.fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(42)
    const isJobEmpty = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const internals = fakeRunnerInternals({ pollProcessExit, isJobEmpty })
    try {
      const running = runSpawnRunner(win32RunnerArgs(files.requestPath, files.eventsPath, [
        '--stdin-pipe', '\\\\.\\pipe\\stdin',
        '--stdout-pipe', '\\\\.\\pipe\\stdout',
        '--stderr-pipe', '\\\\.\\pipe\\stderr',
      ]), asRunnerHost(host), internals)
      await vi.advanceTimersByTimeAsync(30)
      await running

      expect(host.env).toEqual({ ONLY: 'kept' })
      expect(host.directory).toBe('C:\\runner')
      expect(host.disconnect).toHaveBeenCalledOnce()
      expect(internals.openNamedPipeForStdio).toHaveBeenNthCalledWith(
        1,
        fakeWin32Api,
        '\\\\.\\pipe\\stdin',
        'read',
      )
      expect(internals.openNamedPipeForStdio).toHaveBeenNthCalledWith(
        2,
        fakeWin32Api,
        '\\\\.\\pipe\\stdout',
        'write',
      )
      expect(internals.openNamedPipeForStdio).toHaveBeenNthCalledWith(
        3,
        fakeWin32Api,
        '\\\\.\\pipe\\stderr',
        'write',
      )
      expect(internals.spawnCurrentTokenJobProcess).toHaveBeenCalledWith(
        fakeWin32Api,
        { command: 'tool.exe', args: ['literal $HOME'], cwd: 'C:\\target' },
        {
          stdin: 70n,
          stdout: 71n,
          stderr: 72n,
        },
      )
      expect(pollProcessExit).toHaveBeenCalledTimes(2)
      expect(isJobEmpty).toHaveBeenCalledTimes(2)
      expect(readRunnerEvents(files.eventsPath)).toEqual([
        { type: 'started', pid: 1234 },
        { type: 'exit', exitCode: 42, signal: null },
      ])
      expect(internals.closeHandleChecked).toHaveBeenCalledWith(
        fakeWin32Api,
        fakeProcessHandle,
        'ordinary direct process',
      )
      expect(internals.closeHandleChecked).toHaveBeenCalledWith(
        fakeWin32Api,
        fakeJobHandle,
        'ordinary process Job',
      )
    } finally {
      vi.useRealTimers()
      cleanupRunnerFiles(files)
    }
  })

  it('accepts only the Win32 terminate IPC message and coalesces disconnect', async () => {
    vi.useFakeTimers()
    const files = createRunnerFiles({ argv: ['tool.exe'], cwd: 'C:\\target', env: {} })
    const host = new FakeRunnerHost()
    const internals = fakeRunnerInternals()
    try {
      const running = runSpawnRunner(
        win32RunnerArgs(files.requestPath, files.eventsPath),
        asRunnerHost(host),
        internals,
      )
      host.emit('message', null)
      host.emit('message', 'terminate')
      host.emit('message', { type: 'other' })
      host.emit('message', { type: 'terminate' })
      host.emit('message', { type: 'terminate' })
      host.emit('disconnect')
      await vi.advanceTimersByTimeAsync(10)
      await running

      expect(internals.terminateJob).toHaveBeenCalledOnce()
      expect(internals.terminateJob).toHaveBeenCalledWith(fakeWin32Api, fakeJobHandle, 1)
      expect(host.disconnect).not.toHaveBeenCalled()
      expect(readRunnerEvents(files.eventsPath)).toEqual([
        { type: 'started', pid: 1234 },
        { type: 'exit', exitCode: 0, signal: null },
      ])
    } finally {
      vi.useRealTimers()
      cleanupRunnerFiles(files)
    }
  })

  it('reports a non-Error Win32 termination failure and closes both live handles', async () => {
    const files = createRunnerFiles({ argv: ['tool.exe'], cwd: 'C:\\target', env: {} })
    const host = new FakeRunnerHost()
    host.connected = true
    const terminateJob = vi.fn(() => { throw 'raw termination failure' })
    const internals = fakeRunnerInternals({ terminateJob })
    try {
      const running = runSpawnRunner(
        win32RunnerArgs(files.requestPath, files.eventsPath),
        asRunnerHost(host),
        internals,
      )
      host.emit('disconnect')
      await running

      expect(host.exitCode).toBe(127)
      expect(host.disconnect).toHaveBeenCalledOnce()
      expect(readRunnerEvents(files.eventsPath)).toEqual([
        { type: 'started', pid: 1234 },
        { type: 'runner-error', error: { name: 'Error', message: 'raw termination failure' } },
      ])
      expect(internals.closeHandleChecked).toHaveBeenCalledWith(
        fakeWin32Api,
        fakeProcessHandle,
        'ordinary direct process cleanup',
      )
      expect(internals.closeHandleChecked).toHaveBeenCalledWith(
        fakeWin32Api,
        fakeJobHandle,
        'ordinary process Job cleanup',
      )
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it.each([
    [2, 'ENOENT'],
    [3, 'ENOENT'],
    [267, 'ENOENT'],
    [5, 'EACCES'],
    [193, 'EFTYPE'],
    [999, 'UNKNOWN'],
  ] as const)('maps Win32 CreateProcess error %i to %s', async (win32Code, code) => {
    const files = createRunnerFiles({
      argv: ['missing.exe', 'literal argument'],
      cwd: 'C:\\target',
      env: {},
    })
    const host = new FakeRunnerHost()
    const internals = fakeRunnerInternals({
      spawnCurrentTokenJobProcess: vi.fn(() => {
        throw new Win32Error('CreateProcessW', win32Code)
      }),
    })
    try {
      await runSpawnRunner(
        win32RunnerArgs(files.requestPath, files.eventsPath),
        asRunnerHost(host),
        internals,
      )
      expect(host.exitCode).toBeUndefined()
      const [event] = readRunnerEvents(files.eventsPath)
      expect(event?.type).toBe('spawn-error')
      if (event?.type !== 'spawn-error') throw new Error('expected spawn error')
      expect(event.error).toMatchObject({
        code,
        syscall: 'spawn missing.exe',
        path: 'missing.exe',
        spawnargs: ['literal argument'],
      })
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it.each([
    [undefined, false],
    ['ENOENT', true],
  ] as const)('maps a target chdir failure with code %s', async (code, hasSpawnShape) => {
    const files = createRunnerFiles({ argv: ['tool.exe', 'arg'], cwd: 'C:\\missing', env: {} })
    const host = new FakeRunnerHost()
    const error = Object.assign(new Error('target cwd failed'), {
      syscall: 'chdir',
      ...code === undefined ? {} : { code },
    })
    host.chdir = vi.fn(() => { throw error })
    try {
      await runSpawnRunner(
        win32RunnerArgs(files.requestPath, files.eventsPath),
        asRunnerHost(host),
        fakeRunnerInternals(),
      )
      expect(host.exitCode).toBeUndefined()
      const [event] = readRunnerEvents(files.eventsPath)
      expect(event?.type).toBe('spawn-error')
      if (event?.type !== 'spawn-error') throw new Error('expected spawn error')
      expect(typeof event.error.message).toBe('string')
      expect('path' in event.error).toBe(hasSpawnShape)
      if (hasSpawnShape) {
        expect(event.error).toMatchObject({
          code: 'ENOENT',
          syscall: 'spawn tool.exe',
          path: 'tool.exe',
          spawnargs: ['arg'],
        })
      } else {
        expect(event.error).toMatchObject({ message: 'target cwd failed', syscall: 'chdir' })
      }
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it.each([
    ['a non-CreateProcess Win32 error', new Win32Error('CreateFileW', 5), 'Win32Error'],
    ['a non-Error setup failure', 'raw pipe setup failure', 'Error'],
  ])('reports %s as runner infrastructure failure', async (_label, failure, name) => {
    const files = createRunnerFiles({ argv: ['tool.exe'], cwd: 'C:\\target', env: {} })
    const host = new FakeRunnerHost()
    const internals = fakeRunnerInternals({
      openNamedPipeForStdio: vi.fn(() => { throw failure }),
    })
    try {
      await runSpawnRunner(win32RunnerArgs(files.requestPath, files.eventsPath, [
        '--stdin-pipe', '\\\\.\\pipe\\stdin',
      ]), asRunnerHost(host), internals)
      expect(host.exitCode).toBe(127)
      const [event] = readRunnerEvents(files.eventsPath)
      expect(event?.type).toBe('runner-error')
      if (event?.type !== 'runner-error') throw new Error('expected runner error')
      expect(event.error.name).toBe(name)
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it.each([
    ['an Error', new Error('stdio close failed')],
    ['a non-Error value', 'raw stdio close failure'],
  ])('reports %s from the initial stdio close and retries cleanup', async (_label, failure) => {
    const files = createRunnerFiles({ argv: ['tool.exe'], cwd: 'C:\\target', env: {} })
    let failedOnce = false
    const closeHandleChecked = vi.fn((_api, _handle, label: string) => {
      if (!failedOnce && label.includes('pipe')) {
        failedOnce = true
        throw failure
      }
    })
    const internals = fakeRunnerInternals({ closeHandleChecked })
    try {
      await runSpawnRunner(win32RunnerArgs(files.requestPath, files.eventsPath, [
        '--stdin-pipe', '\\\\.\\pipe\\stdin',
      ]), asRunnerHost(new FakeRunnerHost()), internals)
      expect(readRunnerEvents(files.eventsPath)).toEqual([
        { type: 'started', pid: 1234 },
        {
          type: 'runner-error',
          error: { name: 'Error', message: failure instanceof Error ? failure.message : failure },
        },
      ])
      expect(closeHandleChecked).toHaveBeenCalledWith(
        fakeWin32Api,
        70n,
        'ordinary target stdin pipe',
      )
      expect(closeHandleChecked).toHaveBeenCalledWith(
        fakeWin32Api,
        70n,
        'ordinary target stdin pipe',
      )
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('preserves the first stdio close failure while retaining every failed handle', async () => {
    const files = createRunnerFiles({ argv: ['tool.exe'], cwd: 'C:\\target', env: {} })
    let remainingFailures = 2
    const closeHandleChecked = vi.fn((_api, _handle, label: string) => {
      if (remainingFailures > 0 && label.includes('pipe')) {
        remainingFailures -= 1
        throw remainingFailures === 1 ? new Error('first close failure') : 'second close failure'
      }
    })
    const internals = fakeRunnerInternals({ closeHandleChecked })
    try {
      await runSpawnRunner(win32RunnerArgs(files.requestPath, files.eventsPath, [
        '--stdin-pipe', '\\\\.\\pipe\\stdin',
        '--stdout-pipe', '\\\\.\\pipe\\stdout',
      ]), asRunnerHost(new FakeRunnerHost()), internals)
      expect(readRunnerEvents(files.eventsPath)).toContainEqual({
        type: 'runner-error',
        error: { name: 'Error', message: 'first close failure' },
      })
      expect(closeHandleChecked).toHaveBeenCalledTimes(6)
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it.each([
    ['poll', 'poll failed'],
    ['direct close', 'direct close failed'],
    ['Job query', 'Job query failed'],
    ['Job close', 'Job close failed'],
  ] as const)('reports a Win32 %s failure and cleans remaining handles', async (stage, message) => {
    vi.useFakeTimers()
    const files = createRunnerFiles({ argv: ['tool.exe'], cwd: 'C:\\target', env: {} })
    const pollProcessExit = vi.fn(() => {
      if (stage === 'poll') throw new Error(message)
      return 0
    })
    const isJobEmpty = vi.fn(() => {
      if (stage === 'Job query') throw new Error(message)
      return true
    })
    const closeHandleChecked = vi.fn((_api, _handle, label: string) => {
      if (stage === 'direct close' && label === 'ordinary direct process') {
        throw new Error(message)
      }
      if (stage === 'Job close' && label === 'ordinary process Job') {
        throw new Error(message)
      }
      if (label.endsWith('cleanup')) throw new Error('ignored cleanup failure')
    })
    const internals = fakeRunnerInternals({ pollProcessExit, isJobEmpty, closeHandleChecked })
    try {
      const running = runSpawnRunner(
        win32RunnerArgs(files.requestPath, files.eventsPath),
        asRunnerHost(new FakeRunnerHost()),
        internals,
      )
      await vi.advanceTimersByTimeAsync(10)
      await running

      expect(readRunnerEvents(files.eventsPath)).toEqual([
        { type: 'started', pid: 1234 },
        ...stage === 'poll' ? [] : [{ type: 'exit' as const, exitCode: 0, signal: null }],
        { type: 'runner-error', error: { name: 'Error', message } },
      ])
      expect(closeHandleChecked).toHaveBeenCalledWith(
        fakeWin32Api,
        fakeJobHandle,
        expect.stringContaining('Job'),
      )
    } finally {
      vi.useRealTimers()
      cleanupRunnerFiles(files)
    }
  })

  it('preserves the first failure when termination settles reentrantly during polling', async () => {
    vi.useFakeTimers()
    const files = createRunnerFiles({ argv: ['tool.exe'], cwd: 'C:\\target', env: {} })
    const host = new FakeRunnerHost()
    const terminateJob = vi.fn(() => { throw new Error('reentrant termination failed') })
    const pollProcessExit = vi.fn(() => {
      host.emit('disconnect')
      return 0
    })
    const internals = fakeRunnerInternals({ terminateJob, pollProcessExit })
    try {
      const running = runSpawnRunner(
        win32RunnerArgs(files.requestPath, files.eventsPath),
        asRunnerHost(host),
        internals,
      )
      await vi.advanceTimersByTimeAsync(10)
      await running

      expect(readRunnerEvents(files.eventsPath)).toEqual([
        { type: 'started', pid: 1234 },
        { type: 'exit', exitCode: 0, signal: null },
        {
          type: 'runner-error',
          error: { name: 'Error', message: 'reentrant termination failed' },
        },
      ])
    } finally {
      vi.useRealTimers()
      cleanupRunnerFiles(files)
    }
  })

  it('reports failure while restoring cwd after a successful Win32 spawn', async () => {
    const files = createRunnerFiles({ argv: ['tool.exe'], cwd: 'C:\\target', env: {} })
    const host = new FakeRunnerHost()
    host.directory = 'C:\\runner'
    const chdir = vi.fn((directory: string) => {
      if (directory === 'C:\\runner') throw new Error('cwd restore failed')
      host.directory = directory
    })
    host.chdir = chdir
    try {
      await runSpawnRunner(
        win32RunnerArgs(files.requestPath, files.eventsPath),
        asRunnerHost(host),
        fakeRunnerInternals(),
      )
      expect(chdir).toHaveBeenCalledTimes(2)
      expect(host.exitCode).toBe(127)
      expect(readRunnerEvents(files.eventsPath)).toEqual([
        { type: 'started', pid: 1234 },
        { type: 'runner-error', error: { name: 'Error', message: 'cwd restore failed' } },
      ])
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('disconnects after an uncaught Win32 binding setup failure', async () => {
    const files = createRunnerFiles({ argv: ['tool.exe'], cwd: 'C:\\target', env: {} })
    const host = new FakeRunnerHost()
    host.connected = true
    const internals = fakeRunnerInternals({
      loadWin32ProcessBindings: vi.fn(() => { throw new Error('binding setup failed') }),
    })
    try {
      await expect(runSpawnRunner(
        win32RunnerArgs(files.requestPath, files.eventsPath),
        asRunnerHost(host),
        internals,
      )).rejects.toThrow('binding setup failed')
      expect(host.disconnect).toHaveBeenCalledOnce()
      expect(readRunnerEvents(files.eventsPath)).toEqual([])
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it.each([
    [['--mode'], 'missing value'],
    [['--unknown', 'value'], 'unknown argument'],
    [['--mode', 'unknown'], 'unknown mode'],
    [['--mode', 'node'], 'requires request and event paths'],
  ] as const)('rejects invalid runner arguments: %s', async (argv, message) => {
    await expect(runSpawnRunner([...argv], asRunnerHost(new FakeRunnerHost()))).rejects.toThrow(message)
  })

  it('reports only failures whose arguments identify an event transport', () => {
    const files = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      reportSpawnRunnerFailure([
        '--mode', 'node',
        '--request', files.requestPath,
        '--events', files.eventsPath,
      ], new Error('runner main failed'))
      reportSpawnRunnerFailure(['--mode', 'probe-node'], new Error('ignored probe failure'))
      reportSpawnRunnerFailure(['--mode'], new Error('unparseable failure'))
      expect(readRunnerEvents(files.eventsPath)).toEqual([
        { type: 'runner-error', error: { name: 'Error', message: 'runner main failed' } },
      ])
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('maps every target stdio disposition', () => {
    expect(runnerStdio(spec())).toEqual(['ignore', 'pipe', 'pipe'])
    expect(runnerStdio(spec({
      stdio: { stdin: { data: 'input' }, stdout: 'inherit', stderr: 'inherit' },
    }))).toEqual(['pipe', 'inherit', 'inherit'])
  })

  it('materializes and consumes the exact runner request once', () => {
    const removed = `DSH_RUNNER_REMOVED_${process.pid}`
    const files = runnerFiles(spec({
      argv: [process.execPath, 'literal $HOME'],
      env: { RUNNER_VALUE: 'explicit', [removed]: undefined },
    }))
    try {
      const request = consumeRunnerRequest(files.requestPath)
      expect(request.argv).toEqual([process.execPath, 'literal $HOME'])
      expect(request.cwd).toBe(process.cwd())
      expect(request.env.RUNNER_VALUE).toBe('explicit')
      expect(request.env).not.toHaveProperty(removed)
      expect(existsSync(files.requestPath)).toBe(false)
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it.each([
    ['non-object request', null, 'no executable'],
    ['non-array argv', { argv: 'node', cwd: '.', env: {} }, 'no executable'],
    ['empty argv', { argv: [], cwd: '.', env: {} }, 'no executable'],
    ['non-string argv', { argv: [1], cwd: '.', env: {} }, 'no executable'],
    ['non-string cwd', { argv: ['node'], cwd: 1, env: {} }, 'invalid cwd or environment'],
    ['non-record env', { argv: ['node'], cwd: '.', env: [] }, 'invalid cwd or environment'],
    ['non-string env value', { argv: ['node'], cwd: '.', env: { VALUE: 1 } }, 'invalid cwd or environment'],
  ])('rejects an invalid %s', (_label, request, message) => {
    const files = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      writeFileSync(files.requestPath, JSON.stringify(request))
      expect(() => consumeRunnerRequest(files.requestPath)).toThrow(message)
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('unlinks a substituted runner-directory link without traversing it', () => {
    const files = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    const outside = mkdtempSync(join(tmpdir(), 'dsh-runner-outside-'))
    const sentinel = join(outside, 'events.ndjson')
    writeFileSync(sentinel, 'keep')
    rmSync(files.directory, { recursive: true, force: true })
    symlinkSync(outside, files.directory, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      cleanupRunnerFiles(files)
      expect(existsSync(files.directory)).toBe(false)
      expect(existsSync(sentinel)).toBe(true)
    } finally {
      rmSync(files.directory, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('contains an unexpected owned-path cleanup failure', () => {
    const files = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    rmSync(files.requestPath, { force: true })
    mkdirSync(files.requestPath)
    try {
      expect(() => { cleanupRunnerFiles(files) }).not.toThrow()
      expect(existsSync(files.directory)).toBe(true)
    } finally {
      rmSync(files.directory, { recursive: true, force: true })
    }
  })

  it('reads only complete known event records and propagates file errors', async () => {
    const files = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      expect(readRunnerEvents(files.eventsPath)).toEqual([])
      await expect(readRunnerEventsAsync(join(files.directory, 'missing.ndjson'))).resolves.toEqual([])
      appendRunnerEvent(files.eventsPath, { type: 'started', pid: 123 })
      appendRunnerEvent(files.eventsPath, {
        type: 'runner-error',
        error: { name: 'Error', message: 'runner failed' },
      })
      appendRunnerEvent(files.eventsPath, { type: 'exit', exitCode: null, signal: 'SIGTERM' })
      appendRunnerEvent(files.eventsPath, {
        type: 'spawn-error',
        error: {
          name: 'Error',
          message: 'spawn failed',
          code: 'ENOENT',
          errno: -2,
          syscall: 'spawn missing',
          path: 'missing',
          spawnargs: ['argument'],
        },
      })
      expect(readRunnerEvents(files.eventsPath)).toEqual([
        { type: 'started', pid: 123 },
        { type: 'runner-error', error: { name: 'Error', message: 'runner failed' } },
        { type: 'exit', exitCode: null, signal: 'SIGTERM' },
        {
          type: 'spawn-error',
          error: {
            name: 'Error',
            message: 'spawn failed',
            code: 'ENOENT',
            errno: -2,
            syscall: 'spawn missing',
            path: 'missing',
            spawnargs: ['argument'],
          },
        },
      ])
      await expect(readRunnerEventsAsync(files.eventsPath)).resolves.toEqual(readRunnerEvents(files.eventsPath))

      writeFileSync(files.eventsPath, '{"type":"started","pid":123}\n{"type":"exit"')
      expect(readRunnerEvents(files.eventsPath)).toEqual([{ type: 'started', pid: 123 }])
      for (const event of [null, []]) {
        writeFileSync(files.eventsPath, `${JSON.stringify(event)}\n`)
        expect(() => readRunnerEvents(files.eventsPath)).toThrow('emitted invalid event')
      }
      writeFileSync(files.eventsPath, '{"type":"unknown"}\n')
      expect(() => readRunnerEvents(files.eventsPath)).toThrow('emitted unknown event')
      await expect(readRunnerEventsAsync(files.eventsPath)).rejects.toThrow('emitted unknown event')
      expect(() => readRunnerEvents(files.directory)).toThrow()
      await expect(readRunnerEventsAsync(files.directory)).rejects.toThrow()
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it.each([
    ['started without a pid', { type: 'started' }],
    ['started with a non-number pid', { type: 'started', pid: '1' }],
    ['started with a fractional pid', { type: 'started', pid: 1.5 }],
    ['started with a non-positive pid', { type: 'started', pid: 0 }],
    ['exit with a missing code', { type: 'exit', signal: null }],
    ['exit with a non-number code', { type: 'exit', exitCode: '0', signal: null }],
    ['exit with a fractional code', { type: 'exit', exitCode: 1.5, signal: null }],
    ['exit with a negative code', { type: 'exit', exitCode: -1, signal: null }],
    ['exit with a non-string signal', { type: 'exit', exitCode: 0, signal: 9 }],
    ['exit with an unknown signal', { type: 'exit', exitCode: 0, signal: 'NOT_A_SIGNAL' }],
    ['spawn error without an object', { type: 'spawn-error', error: null }],
    ['spawn error without a name', { type: 'spawn-error', error: { message: 'failed' } }],
    ['spawn error without a message', { type: 'spawn-error', error: { name: 'Error' } }],
    ['spawn error with a numeric code', { type: 'spawn-error', error: { name: 'Error', message: 'failed', code: 1 } }],
    ['spawn error with a string errno', { type: 'spawn-error', error: { name: 'Error', message: 'failed', errno: '1' } }],
    ['spawn error with a numeric syscall', { type: 'spawn-error', error: { name: 'Error', message: 'failed', syscall: 1 } }],
    ['spawn error with a numeric path', { type: 'spawn-error', error: { name: 'Error', message: 'failed', path: 1 } }],
    ['spawn error with non-array args', { type: 'spawn-error', error: { name: 'Error', message: 'failed', spawnargs: 'arg' } }],
    ['spawn error with non-string args', { type: 'spawn-error', error: { name: 'Error', message: 'failed', spawnargs: [1] } }],
  ])('rejects an invalid event payload: %s', (_label, event) => {
    const files = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      writeFileSync(files.eventsPath, `${JSON.stringify(event)}\n`)
      expect(() => readRunnerEvents(files.eventsPath)).toThrow('emitted invalid event')
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('creates private request files and preserves Node-shaped error fields', () => {
    const files = createRunnerFiles({ argv: [process.execPath], cwd: process.cwd(), env: {} })
    try {
      if (process.platform !== 'win32') expect(statSync(files.requestPath).mode & 0o777).toBe(0o600)
      const source = Object.assign(new Error('spawn missing ENOENT'), {
        code: 'ENOENT',
        errno: -2,
        syscall: 'spawn missing',
        path: 'missing',
        spawnargs: ['literal $VALUE'],
      })
      const restored = deserializeSpawnError(serializeSpawnError(source)) as NodeJS.ErrnoException & {
        path?: string
        spawnargs?: string[]
      }
      expect(restored).toMatchObject({
        message: 'spawn missing ENOENT',
        code: 'ENOENT',
        errno: -2,
        syscall: 'spawn missing',
        path: 'missing',
        spawnargs: ['literal $VALUE'],
      })
      const minimal = serializeSpawnError('plain failure')
      expect(minimal).toEqual({ name: 'Error', message: 'plain failure' })
      expect(deserializeSpawnError(minimal)).toMatchObject({ name: 'Error', message: 'plain failure' })
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('maps runner failures and missing direct results', async () => {
    const runnerFailure = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      appendRunnerEvent(runnerFailure.eventsPath, {
        type: 'runner-error',
        error: { name: 'Error', message: 'runner setup failed', code: 'EIO' },
      })
      const result = runnerDirectResult(fakeChild(123), runnerFailure, new Promise<void>(() => {}))
      expect(result.pid).toBeUndefined()
      await expect(result.direct).rejects.toMatchObject({ message: 'runner setup failed', code: 'EIO' })
    } finally {
      cleanupRunnerFiles(runnerFailure)
    }

    const afterStartFailure = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      appendRunnerEvent(afterStartFailure.eventsPath, { type: 'started', pid: 456 })
      const result = runnerDirectResult(fakeChild(123), afterStartFailure, new Promise<void>(() => {}))
      const directFailure = result.direct.catch((error: unknown) => error)
      appendRunnerEvent(afterStartFailure.eventsPath, {
        type: 'runner-error',
        error: { name: 'Error', message: 'post-start runner failed', code: 'EIO' },
      })
      await vi.waitFor(() => { expect(result.pid).toBe(456) })
      await expect(directFailure).resolves.toMatchObject({ message: 'post-start runner failed', code: 'EIO' })
    } finally {
      cleanupRunnerFiles(afterStartFailure)
    }

    const missing = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      appendRunnerEvent(missing.eventsPath, { type: 'started', pid: 456 })
      const result = runnerDirectResult(fakeChild(123), missing, Promise.resolve())
      await vi.waitFor(() => { expect(result.pid).toBe(456) })
      await expect(result.direct).rejects.toThrow('exited without a direct-command result')
    } finally {
      cleanupRunnerFiles(missing)
    }

  })

  it('publishes terminal events already present when asynchronous observation starts', async () => {
    const failed = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      appendRunnerEvent(failed.eventsPath, {
        type: 'spawn-error',
        error: { name: 'Error', message: 'target missing', code: 'ENOENT' },
      })
      const result = runnerDirectResult(fakeChild(123), failed, new Promise<void>(() => {}))
      await expect(result.direct).rejects.toMatchObject({ message: 'target missing', code: 'ENOENT' })
    } finally {
      cleanupRunnerFiles(failed)
    }

    const exited = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      appendRunnerEvent(exited.eventsPath, { type: 'started', pid: 456 })
      appendRunnerEvent(exited.eventsPath, { type: 'exit', exitCode: 23, signal: null })
      const result = runnerDirectResult(fakeChild(123), exited, new Promise<void>(() => {}))
      await expect(result.direct).resolves.toEqual({ exitCode: 23, signal: null })
      expect(result.pid).toBe(456)
    } finally {
      cleanupRunnerFiles(exited)
    }
  })

  it('requires an event snapshot started after wrapper exit before reporting a missing result', async () => {
    const staleRead = Promise.withResolvers<Awaited<ReturnType<typeof readRunnerEventsAsync>>>()
    let readCount = 0
    vi.resetModules()
    vi.doMock('../src/runner-protocol.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/runner-protocol.ts')>()
      return {
        ...actual,
        readRunnerEventsAsync: vi.fn(async (eventsPath: string) => {
          readCount += 1
          if (readCount === 1) return staleRead.promise
          return actual.readRunnerEvents(eventsPath)
        }),
      }
    })
    const files = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      appendRunnerEvent(files.eventsPath, { type: 'started', pid: 456 })
      const exited = Promise.withResolvers<undefined>()
      const isolated = await import('../src/runner-launch.ts')
      const result = isolated.runnerDirectResult(fakeChild(123), files, exited.promise)
      expect(readCount).toBe(1)
      exited.resolve(undefined)
      await Promise.resolve()
      appendRunnerEvent(files.eventsPath, { type: 'exit', exitCode: 0, signal: null })
      staleRead.resolve([{ type: 'started', pid: 456 }])
      await expect(result.direct).resolves.toEqual({ exitCode: 0, signal: null })
      expect(readCount).toBe(2)
    } finally {
      cleanupRunnerFiles(files)
      vi.doUnmock('../src/runner-protocol.ts')
      vi.resetModules()
    }
  })

  it('reports a missing direct result at runner exit without waiting for pipe close', async () => {
    const files = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      appendRunnerEvent(files.eventsPath, { type: 'started', pid: 456 })
      const child = new EventEmitter() as ChildProcess
      Object.assign(child, { pid: 123, exitCode: null, signalCode: null })
      const lifecycle = observeChildLifecycle(child)
      const result = runnerDirectResult(child, files, lifecycle.exited)
      child.emit('exit', 1, null)
      await expect(result.direct).rejects.toThrow('exited without a direct-command result')
      child.emit('close', 1, null)
      await lifecycle.closed
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('contains wrapper spawn errors while publishing the runner startup rejection', async () => {
    const files = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      const child = spawn(`missing-dsh-native-runner-${String(process.pid)}-${String(Date.now())}`, [], {
        stdio: 'ignore',
      })
      const lifecycle = observeChildLifecycle(child)
      const result = runnerDirectResult(child, files, lifecycle.exited)
      expect(result.pid).toBeUndefined()
      await expect(result.direct).rejects.toThrow('runner failed to start')
      await expect(lifecycle.closed).resolves.toBeUndefined()
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('returns before target publication and updates the pid getter from runner events', async () => {
    const files = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      const result = runnerDirectResult(fakeChild(process.pid), files, new Promise<void>(() => {}))
      expect(result.pid).toBeUndefined()
      appendRunnerEvent(files.eventsPath, { type: 'started', pid: 456 })
      await vi.waitFor(() => { expect(result.pid).toBe(456) })
      appendRunnerEvent(files.eventsPath, { type: 'exit', exitCode: 0, signal: null })
      await expect(result.direct).resolves.toEqual({ exitCode: 0, signal: null })
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('cleans runner files only after the direct result and runner close settle', async () => {
    const files = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    const closed = Promise.withResolvers<undefined>()
    cleanupAfterRunner(files, Promise.resolve({ exitCode: 0, signal: null }), closed.promise)
    await new Promise(resolve => setImmediate(resolve))
    expect(existsSync(files.directory)).toBe(true)
    closed.resolve(undefined)
    await new Promise(resolve => setImmediate(resolve))
    expect(existsSync(files.directory)).toBe(false)
  })

  it('reports the direct target pid and exit outcome from the source entry', () => {
    const files = createRunnerFiles({
      argv: [process.execPath, '-e', 'process.exit(7)'],
      cwd: process.cwd(),
      env: {},
    })
    try {
      const result = runRunner(sourceInvocation, files.requestPath, files.eventsPath)
      expect(result.error).toBeUndefined()
      const events = readRunnerEvents(files.eventsPath)
      expect(events).toHaveLength(2)
      expect(events[0]?.type).toBe('started')
      if (events[0]?.type !== 'started') throw new Error('expected started event')
      expect(events[0].pid).toBeGreaterThan(0)
      expect(events[1]).toEqual({ type: 'exit', exitCode: 7, signal: null })
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('preserves literal argv, cwd, and the exact target environment', () => {
    const files = createRunnerFiles({
      argv: [
        process.execPath,
        '-e',
        'console.log(JSON.stringify({ cwd: process.cwd(), value: process.env.RUNNER_VALUE, arg: process.argv[1] }))',
        'literal $HOME ${UNCHANGED}',
      ],
      cwd: process.cwd(),
      env: { RUNNER_VALUE: 'explicit' },
    })
    try {
      const result = runRunner(sourceInvocation, files.requestPath, files.eventsPath)
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe(JSON.stringify({
        cwd: process.cwd(),
        value: 'explicit',
        arg: 'literal $HOME ${UNCHANGED}',
      }))
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('reports target spawn failure without executing a fallback command', () => {
    const files = createRunnerFiles({
      argv: [`missing-dsh-runner-${Date.now()}`],
      cwd: process.cwd(),
      env: {},
    })
    try {
      const result = runRunner(sourceInvocation, files.requestPath, files.eventsPath)
      expect(result.error).toBeUndefined()
      const events = readRunnerEvents(files.eventsPath)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'spawn-error', error: { code: 'ENOENT' } })
    } finally {
      cleanupRunnerFiles(files)
    }
  })

})
