/**
 * The `node:child_process` face over the in-worker shell, and the ladder above
 * it: the REAL local subprocess service, running unmodified against this
 * module instead of a host kernel. That ladder is what the bash tool walks in
 * the browser, so proving it here is what makes the browser probe a
 * confirmation rather than the only evidence.
 *
 * A Node test host has no DOM `Worker`, so the commands here run through the
 * inline strategy; the worker strategy and its frames are proven in
 * `../shell/shell-process.spec.ts`, and both meet again in the preview probe.
 *
 * `process.kill` is redirected to the worker's process table for the same
 * reason the worker does it: the subprocess service polls process-group
 * liveness through it, and on a test host those pids belong to real processes.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryVfs } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts'
import { setActiveVfs } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/active.ts'
import { spawn, spawnSync } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/child_process.ts'
import { processAlive, signalProcess } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/process-table.ts'
import { spawnSubprocess } from '@deepseek-ai/dsh-subprocess-local/src/spawn.ts'

vi.mock('node:child_process', async () =>
  await import('@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/child_process.ts'))

const WORKSPACE = '/dsh/workspace'

let vfs: MemoryVfs

beforeEach(() => {
  vfs = new MemoryVfs()
  setActiveVfs(vfs)
  vfs.mkdirSync(WORKSPACE, { recursive: true })
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number): true => {
    if (signal === 0) {
      if (processAlive(pid)) return true
      const error = new Error('kill ESRCH') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    }
    signalProcess(pid, (signal ?? 'SIGTERM') as NodeJS.Signals)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Collect one child's stdout, stderr, and settlement. */
async function collect(child: ReturnType<typeof spawn>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: unknown) => { stdout += String(chunk) })
  child.stderr?.on('data', (chunk: unknown) => { stderr += String(chunk) })
  const code = await new Promise<number | null>((settle, fail) => {
    child.on('close', (value: unknown) => { settle(value as number | null) })
    child.on('error', fail)
  })
  return { stdout, stderr, code }
}

it('runs a bash command line and reports its output through the pipes', async () => {
  const child = spawn('bash', ['-c', 'echo hi; echo oops >&2'], { cwd: WORKSPACE })
  expect(child.pid).toBeGreaterThan(1)
  expect(await collect(child)).toEqual({ stdout: 'hi\n', stderr: 'oops\n', code: 0 })
})

it('runs an explicit argv without re-parsing it as a command line', async () => {
  vfs.writeFileSync(`${WORKSPACE}/spaced name.txt`, 'kept\n')
  const child = spawn('cat', ['spaced name.txt'], { cwd: WORKSPACE })
  expect((await collect(child)).stdout).toBe('kept\n')
})

it('fails a program the command table does not hold the way a missing binary does', async () => {
  const child = spawn('nowhere-binary', [], { cwd: WORKSPACE })
  // A caller that configures the pipes first (the browser launcher does) must
  // reach the ENOENT, not a TypeError on the configuration line.
  child.stdout?.setEncoding()
  child.stderr?.setEncoding()
  const error = await new Promise<NodeJS.ErrnoException>((settle) => {
    child.on('error', (value: unknown) => { settle(value as NodeJS.ErrnoException) })
  })
  expect(error.code).toBe('ENOENT')
  expect(error.syscall).toBe('spawn nowhere-binary')
})

it('refuses a command name that is not a string, as Node does', () => {
  expect(() => spawn(undefined as unknown as string)).toThrow(/must be a non-empty string/)
})

it('reports that a synchronous run cannot happen, without throwing at the probe', () => {
  expect(spawnSync('bwrap').error?.code).toBe('ENOENT')
  expect(spawnSync('echo').error?.message).toContain('commands run asynchronously')
})

it('carries a command through the real local subprocess service', async () => {
  const handle = spawnSubprocess({
    argv: ['bash', '-c', 'echo written > note.txt && cat note.txt'],
    cwd: WORKSPACE,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs: 3_000,
    env: {},
  })
  const outcome = await handle.done
  expect(outcome).toEqual({ exitCode: 0, signal: null })
  expect(handle.collected.stdout?.readFrom(0).text).toBe('written\n')
  expect(vfs.readFileSync(`${WORKSPACE}/note.txt`, 'utf8')).toBe('written\n')
})

it('writes the caller-supplied standard input into the command', async () => {
  const handle = spawnSubprocess({
    argv: ['bash', '-c', 'grep -c ""'],
    cwd: WORKSPACE,
    stdio: {
      stdin: { data: 'one\ntwo\nthree\n' },
      stdout: { maxBytes: 64_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs: 3_000,
    env: {},
  })
  await handle.done
  expect(handle.collected.stdout?.readFrom(0).text).toBe('3\n')
})

it('kills a running command through the service and reports the signal', async () => {
  const handle = spawnSubprocess({
    argv: ['bash', '-c', 'sleep 30; echo never'],
    cwd: WORKSPACE,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs: 3_000,
    env: {},
  })
  const started = performance.now()
  handle.terminate()
  const outcome = await handle.done
  expect(outcome.signal).toBe('SIGTERM')
  expect(outcome.exitCode).toBeNull()
  expect(handle.collected.stdout?.readFrom(0).text).toBe('')
  // The command settles on the signal, not on the interval it was waiting out:
  // a `sleep` that ignored the abort would hold this handle open for 30s.
  expect(performance.now() - started).toBeLessThan(5_000)
})
