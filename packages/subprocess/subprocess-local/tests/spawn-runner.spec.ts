import { spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  cleanupAfterRunner,
  runnerDirectResult,
  runnerFiles,
  runnerStdio,
} from '../src/runner-launch.ts'
import {
  appendRunnerEvent,
  cleanupRunnerFiles,
  consumeRunnerRequest,
  createRunnerFiles,
  deserializeSpawnError,
  readRunnerEvents,
  serializeSpawnError,
} from '../src/runner-protocol.ts'

const sourceInvocation = [
  process.execPath,
  '--import',
  'tsx/esm',
  fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/src/spawn-runner.ts')),
]
const builtEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess-local/spawn-runner'))

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
  it('selects built and source runner entries according to artifact availability', async () => {
    vi.resetModules()
    vi.doMock('node:fs', async importOriginal => ({
      ...await importOriginal<typeof import('node:fs')>(),
      existsSync: () => true,
    }))
    try {
      const built = await import('../src/runner-launch.ts')
      expect(built.spawnRunnerInvocation()).toEqual([process.execPath, builtEntry])
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }

    vi.doMock('node:fs', async importOriginal => ({
      ...await importOriginal<typeof import('node:fs')>(),
      existsSync: () => false,
    }))
    try {
      const source = await import('../src/runner-launch.ts')
      expect(source.spawnRunnerInvocation()).toEqual(sourceInvocation)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('maps every target stdio disposition and optional IPC channel', () => {
    expect(runnerStdio(spec())).toEqual(['ignore', 'pipe', 'pipe'])
    expect(runnerStdio(spec({
      stdio: { stdin: { data: 'input' }, stdout: 'inherit', stderr: 'inherit' },
    }), true)).toEqual(['pipe', 'inherit', 'inherit', 'ipc'])
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

  it('reads only complete known event records and propagates file errors', () => {
    const files = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      expect(readRunnerEvents(files.eventsPath)).toEqual([])
      appendRunnerEvent(files.eventsPath, { type: 'started', pid: 123 })
      appendRunnerEvent(files.eventsPath, {
        type: 'runner-error',
        error: { name: 'Error', message: 'runner failed' },
      })
      expect(readRunnerEvents(files.eventsPath)).toEqual([
        { type: 'started', pid: 123 },
        { type: 'runner-error', error: { name: 'Error', message: 'runner failed' } },
      ])

      writeFileSync(files.eventsPath, '{"type":"started","pid":123}\n{"type":"exit"')
      expect(readRunnerEvents(files.eventsPath)).toEqual([{ type: 'started', pid: 123 }])
      for (const event of [null, [], { type: 'unknown' }]) {
        writeFileSync(files.eventsPath, `${JSON.stringify(event)}\n`)
        expect(() => readRunnerEvents(files.eventsPath)).toThrow('emitted unknown event')
      }
      expect(() => readRunnerEvents(files.directory)).toThrow()
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

    const missing = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      appendRunnerEvent(missing.eventsPath, { type: 'started', pid: 456 })
      const result = runnerDirectResult(fakeChild(123), missing, Promise.resolve())
      expect(result.pid).toBe(456)
      await expect(result.direct).rejects.toThrow('exited without a direct-command result')
    } finally {
      cleanupRunnerFiles(missing)
    }

    const forced = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    try {
      appendRunnerEvent(forced.eventsPath, { type: 'started', pid: 789 })
      const result = runnerDirectResult(
        fakeChild(123),
        forced,
        Promise.resolve(),
        () => ({ exitCode: null, signal: 'SIGKILL' }),
      )
      await expect(result.direct).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
    } finally {
      cleanupRunnerFiles(forced)
    }
  })

  it('reports runner startup failure and handshake timeout without leaking request files', async () => {
    const missingChild = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    const missingResult = runnerDirectResult(fakeChild(undefined), missingChild, new Promise<void>(() => {}))
    expect(missingResult.pid).toBe(-1)
    await expect(missingResult.direct).rejects.toThrow('runner failed to start')
    expect(existsSync(missingChild.directory)).toBe(false)

    const timedOut = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(10_001)
    try {
      const timedOutResult = runnerDirectResult(fakeChild(123), timedOut, new Promise<void>(() => {}))
      expect(timedOutResult.pid).toBe(-1)
      await expect(timedOutResult.direct).rejects.toThrow('did not report target start')
      expect(existsSync(timedOut.directory)).toBe(false)
    } finally {
      now.mockRestore()
      cleanupRunnerFiles(timedOut)
    }
  })

  it('cleans runner files only after both direct and owner lifecycles settle', async () => {
    const files = createRunnerFiles({ argv: ['node'], cwd: '.', env: {} })
    const exited = Promise.withResolvers<undefined>()
    cleanupAfterRunner(files, Promise.resolve({ exitCode: 0, signal: null }), {
      signal: vi.fn(),
      waitForExit: async () => { await exited.promise; return true },
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(existsSync(files.directory)).toBe(true)
    exited.resolve(undefined)
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

  it.skipIf(!existsSync(builtEntry))('reports direct outcome from the built entry', () => {
    const files = createRunnerFiles({
      argv: [process.execPath, '-e', 'process.exit(11)'],
      cwd: process.cwd(),
      env: {},
    })
    try {
      const result = runRunner([process.execPath, builtEntry], files.requestPath, files.eventsPath)
      expect(result.error).toBeUndefined()
      const events = readRunnerEvents(files.eventsPath)
      expect(events).toHaveLength(2)
      expect(events[0]?.type).toBe('started')
      if (events[0]?.type !== 'started') throw new Error('expected started event')
      expect(events[0].pid).toBeGreaterThan(0)
      expect(events[1]).toEqual({ type: 'exit', exitCode: 11, signal: null })
    } finally {
      cleanupRunnerFiles(files)
    }
  })
})
