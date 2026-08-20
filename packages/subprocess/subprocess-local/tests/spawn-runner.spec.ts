import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  cleanupRunnerFiles,
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
    } finally {
      cleanupRunnerFiles(files)
    }
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
