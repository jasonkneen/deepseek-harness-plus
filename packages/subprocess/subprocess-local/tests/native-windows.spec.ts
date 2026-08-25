import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { bindManagedProcess } from '../src/spawn.ts'
import { launchWindowsJob, probeWindowsJob } from '../src/windows-job.ts'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-native-windows-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

function spec(argv: string[], graceMs = 100, env?: NodeJS.ProcessEnv): SubprocessSpawnSpec {
  return {
    argv,
    cwd: scratch,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs,
    env,
  }
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, 'utf8').trim())
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch {
      // Target has not written its descendant pid yet.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid file ${path} was not written`)
}

async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid ${pid} remained alive`)
}

function cleanup(pid: number): void {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

type SpawnFailure = NodeJS.ErrnoException & { path?: string; spawnargs?: string[] }

function directSpawnFailure(argv: string[], cwd = scratch): Promise<SpawnFailure> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(argv[0] as string, argv.slice(1), { cwd, stdio: 'ignore' })
      child.once('error', resolve)
      child.once('spawn', () => { reject(new Error(`expected ${argv[0]} to fail before spawn`)) })
    } catch (error) {
      resolve(error as SpawnFailure)
    }
  })
}

const windowsNative = process.platform === 'win32' && probeWindowsJob()

describe.skipIf(!windowsNative)('Windows Job native containment', () => {
  it('keeps raw stdin writable before target pid publication', async () => {
    const output = join(scratch, `stdin-${Date.now()}.txt`)
    const script = `
      const { writeFileSync } = require('node:fs')
      let input = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', chunk => { input += chunk })
      process.stdin.on('end', () => { writeFileSync(${JSON.stringify(output)}, input) })
    `
    const request = {
      ...spec([process.execPath, '-e', script]),
      stdio: { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' } as const,
    }
    const handle = bindManagedProcess(request, launchWindowsJob(request))
    if (handle.stdin === undefined) throw new Error('expected piped stdin')
    await new Promise<void>((resolve, reject) => {
      handle.stdin?.once('error', reject)
      handle.stdin?.end('before-publication', resolve)
    })
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(readFileSync(output, 'utf8')).toBe('before-publication')
  })

  it('reports direct exit before terminating its default-inheritance descendant', async () => {
    const pidFile = join(scratch, `job-survivor-${Date.now()}.pid`)
    const factsFile = join(scratch, `job-facts-${Date.now()}.json`)
    const targetCwd = join(scratch, `target-cwd-${Date.now()}`)
    mkdirSync(targetCwd)
    const script = `
      const { spawn } = require('node:child_process')
      const { writeFileSync } = require('node:fs')
      const { dirname } = require('node:path')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dirname(process.execPath), stdio: 'ignore', detached: true })
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
      writeFileSync(${JSON.stringify(factsFile)}, JSON.stringify({ cwd: process.cwd(), value: process.env.TARGET_VALUE, arg: process.argv[1] }))
      child.unref()
      process.stdout.end()
      process.stderr.end()
      process.exitCode = 42
    `
    const request = {
      ...spec([process.execPath, '-e', script, 'literal $HOME ${UNCHANGED}'], 100, { TARGET_VALUE: 'explicit' }),
      cwd: targetCwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } as const,
    }
    const handle = bindManagedProcess(request, launchWindowsJob(request))
    if (handle.stdout === undefined) throw new Error('expected piped stdout')
    if (handle.stderr === undefined) throw new Error('expected piped stderr')
    handle.stdout.resume()
    handle.stderr.resume()
    const stdoutEnded = new Promise<void>((resolve, reject) => {
      handle.stdout?.once('end', resolve)
      handle.stdout?.once('error', reject)
    })
    const stderrEnded = new Promise<void>((resolve, reject) => {
      handle.stderr?.once('end', resolve)
      handle.stderr?.once('error', reject)
    })
    const descendant = await waitForPid(pidFile)
    try {
      await expect(handle.done).resolves.toEqual({ exitCode: 42, signal: null })
      await expect(Promise.race([
        Promise.all([stdoutEnded, stderrEnded]).then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => { resolve(false) }, 5_000)),
      ])).resolves.toBe(true)
      expect(readFileSync(factsFile, 'utf8')).toBe(JSON.stringify({
        cwd: targetCwd,
        value: 'explicit',
        arg: 'literal $HOME ${UNCHANGED}',
      }))
      rmSync(targetCwd, { recursive: true })
      await expect(handle.waitForExit(AbortSignal.timeout(30))).resolves.toBe(false)
      handle.terminate()
      await expect(handle.waitForExit()).resolves.toBe(true)
      await waitGone(descendant)
    } finally {
      cleanup(descendant)
    }
  })

  it('publishes target identity before reporting cwd restoration failure', async () => {
    const preload = join(scratch, `fail-runner-cwd-restore-${Date.now()}.mjs`)
    writeFileSync(preload, `
      const originalChdir = process.chdir.bind(process)
      let calls = 0
      process.chdir = (path) => {
        calls += 1
        if (calls === 2) {
          const error = new Error('injected runner cwd restoration failure')
          error.code = 'ENOENT'
          error.syscall = 'chdir'
          throw error
        }
        originalChdir(path)
      }
    `)
    const previousNodeOptions = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = [previousNodeOptions, `--import=${pathToFileURL(preload).href}`]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join(' ')
    try {
      const command = process.env.ComSpec ?? process.env.COMSPEC
      if (command === undefined) throw new Error('expected ComSpec for the Windows runner test')
      const request = spec([command, '/d', '/s', '/c', 'exit 0'])
      const launch = launchWindowsJob(request)
      expect(launch.pid).toBeUndefined()
      const failure = await launch.direct.catch((error: unknown) => error)
      expect(launch.pid).toBeGreaterThan(0)
      expect(failure).toMatchObject({
        message: 'injected runner cwd restoration failure',
        code: 'ENOENT',
        syscall: 'chdir',
      })
      expect(failure).not.toHaveProperty('path')
      await expect(launch.owner.waitForExit()).rejects.toThrow('before proving its managed range empty')
    } finally {
      if (previousNodeOptions === undefined) Reflect.deleteProperty(process.env, 'NODE_OPTIONS')
      else process.env.NODE_OPTIONS = previousNodeOptions
    }
  })

  it('preserves missing-target and invalid-executable rejection errors', async () => {
    const relativeExecutable = `relative-node-${String(Date.now())}.exe`
    copyFileSync(process.execPath, join(scratch, relativeExecutable))
    const relative = spec([relativeExecutable, '-e', 'process.exit(17)'])
    const relativeHandle = bindManagedProcess(relative, launchWindowsJob(relative))
    await expect(relativeHandle.done).resolves.toEqual({ exitCode: 17, signal: null })
    await expect(relativeHandle.waitForExit()).resolves.toBe(true)

    const missing = spec([`missing-native-target-${Date.now()}.exe`])
    const missingHandle = bindManagedProcess(missing, launchWindowsJob(missing))
    await expect(missingHandle.done).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(missingHandle.waitForExit()).resolves.toBe(true)

    const accessDenied = spec([scratch])
    const expectedAccessDenied = await directSpawnFailure([scratch])
    const accessDeniedHandle = bindManagedProcess(accessDenied, launchWindowsJob(accessDenied))
    await expect(accessDeniedHandle.done).rejects.toMatchObject({ code: 'EACCES' })
    await expect(accessDeniedHandle.done).rejects.toMatchObject({ code: expectedAccessDenied.code })
    await expect(accessDeniedHandle.waitForExit()).resolves.toBe(true)

    const missingCwd = join(scratch, `missing-cwd-${Date.now()}`)
    const cwdArgv = [process.execPath, '-e', 'process.exit(0)']
    const expectedCwd = await directSpawnFailure(cwdArgv, missingCwd)
    const invalidCwd = { ...spec(cwdArgv), cwd: missingCwd }
    const invalidCwdHandle = bindManagedProcess(invalidCwd, launchWindowsJob(invalidCwd))
    await expect(invalidCwdHandle.done).rejects.toMatchObject({
      code: expectedCwd.code,
      syscall: expectedCwd.syscall,
      path: expectedCwd.path,
      spawnargs: expectedCwd.spawnargs,
    })
    await expect(invalidCwdHandle.waitForExit()).resolves.toBe(true)

    const invalidExecutable = join(scratch, `direct-${Date.now()}.exe`)
    writeFileSync(invalidExecutable, 'not a Windows executable\r\n')
    const directError = await directSpawnFailure([invalidExecutable])
    const invalid = spec([invalidExecutable])
    const invalidHandle = bindManagedProcess(invalid, launchWindowsJob(invalid))
    await expect(invalidHandle.done).rejects.toMatchObject({ code: directError.code })
    await expect(invalidHandle.waitForExit()).resolves.toBe(true)
  })
})
