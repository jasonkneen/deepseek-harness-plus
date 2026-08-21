import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  cleanupAfterRunner,
  runnerDirectResult,
  runnerFiles,
  runnerStdio,
  spawnRunnerInvocation,
} from '../src/runner-launch.ts'
import { observeChildClose } from '../src/managed-owner.ts'
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

const sourceInvocation = [
  process.execPath,
  '--import',
  'tsx/esm',
  fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/src/spawn-runner.ts')),
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
  return { pid } as ChildProcess
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
  it('selects the source runner from source-plane execution', () => {
    expect(spawnRunnerInvocation()).toEqual(sourceInvocation)
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

  it('maps runner failures and wrapper-close fallback outcomes', async () => {
    const runnerFailure = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      appendRunnerEvent(runnerFailure.eventsPath, {
        type: 'runner-error',
        error: { name: 'Error', message: 'runner setup failed', code: 'EIO' },
      })
      const result = runnerDirectResult(fakeChild(123), runnerFailure, new Promise<void>(() => {}))
      expect(result.pid).toBe(-1)
      await expect(result.direct).rejects.toMatchObject({ message: 'runner setup failed', code: 'EIO' })
    } finally {
      cleanupRunnerFiles(runnerFailure)
    }

    const afterStartFailure = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      appendRunnerEvent(afterStartFailure.eventsPath, { type: 'started', pid: 456 })
      appendRunnerEvent(afterStartFailure.eventsPath, {
        type: 'runner-error',
        error: { name: 'Error', message: 'post-start runner failed', code: 'EIO' },
      })
      const result = runnerDirectResult(fakeChild(123), afterStartFailure, new Promise<void>(() => {}))
      expect(result.pid).toBe(456)
      await expect(result.direct).rejects.toMatchObject({ message: 'post-start runner failed', code: 'EIO' })
    } finally {
      cleanupRunnerFiles(afterStartFailure)
    }

    const missing = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      appendRunnerEvent(missing.eventsPath, { type: 'started', pid: 456 })
      const result = runnerDirectResult(fakeChild(123), missing, Promise.resolve())
      expect(result.pid).toBe(456)
      await expect(result.direct).rejects.toThrow('exited without a direct-command result')
    } finally {
      cleanupRunnerFiles(missing)
    }

  })

  it('requires an event snapshot started after wrapper close before reporting a missing result', async () => {
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
      const closed = Promise.withResolvers<undefined>()
      const isolated = await import('../src/runner-launch.ts')
      const result = isolated.runnerDirectResult(fakeChild(123), files, closed.promise)
      expect(readCount).toBe(1)
      closed.resolve(undefined)
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

  it('contains wrapper spawn errors while publishing the runner startup rejection', async () => {
    const files = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      const child = spawn(`missing-dsh-native-runner-${String(process.pid)}-${String(Date.now())}`, [], {
        stdio: 'ignore',
      })
      const closed = observeChildClose(child)
      const result = runnerDirectResult(child, files, closed)
      expect(result.pid).toBe(-1)
      await expect(result.direct).rejects.toThrow('runner failed to start')
      await expect(closed).resolves.toBeUndefined()
    } finally {
      cleanupRunnerFiles(files)
    }
  })

  it('reports runner startup failure and handshake timeout without leaking request files', async () => {
    const missingChild = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    const missingResult = runnerDirectResult(fakeChild(undefined), missingChild, new Promise<void>(() => {}))
    expect(missingResult.pid).toBe(-1)
    await expect(missingResult.direct).rejects.toThrow('runner failed to start')
    expect(existsSync(missingChild.directory)).toBe(false)

    const exitedChild = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    const exitedResult = runnerDirectResult(fakeChild(2_147_483_647), exitedChild, new Promise<void>(() => {}))
    expect(exitedResult.pid).toBe(-1)
    await expect(exitedResult.direct).rejects.toThrow('exited before reporting target start')
    expect(existsSync(exitedChild.directory)).toBe(false)

    const timedOut = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(10_001)
    try {
      const timedOutResult = runnerDirectResult(fakeChild(process.pid), timedOut, new Promise<void>(() => {}))
      expect(timedOutResult.pid).toBe(-1)
      await expect(timedOutResult.direct).rejects.toThrow('did not report target start')
      expect(existsSync(timedOut.directory)).toBe(false)
    } finally {
      now.mockRestore()
      cleanupRunnerFiles(timedOut)
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
