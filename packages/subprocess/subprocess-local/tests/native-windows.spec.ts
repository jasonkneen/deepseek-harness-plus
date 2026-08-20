import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function directSpawnFailure(argv: string[]): Promise<NodeJS.ErrnoException> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), { cwd: scratch, stdio: 'ignore' })
    child.once('error', resolve)
    child.once('spawn', () => { reject(new Error(`expected ${argv[0]} to fail before spawn`)) })
  })
}

const windowsNative = process.platform === 'win32' && probeWindowsJob()

describe.skipIf(!windowsNative)('Windows Job native containment', () => {
  it('terminates the direct target and its default-inheritance descendant', async () => {
    const pidFile = join(scratch, `job-child-${Date.now()}.pid`)
    const script = `
      const { spawn } = require('node:child_process')
      const { writeFileSync } = require('node:fs')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true })
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
      setInterval(() => {}, 1000)
    `
    const request = spec([process.execPath, '-e', script])
    const handle = bindManagedProcess(request, launchWindowsJob(request))
    const descendant = await waitForPid(pidFile)
    try {
      handle.terminate()
      await handle.done
      await expect(handle.waitForExit()).resolves.toBe(true)
      await waitGone(descendant)
    } finally {
      cleanup(descendant)
    }
  })

  it('reports direct exit before the inherited descendant leaves the Job', async () => {
    const pidFile = join(scratch, `job-survivor-${Date.now()}.pid`)
    const factsFile = join(scratch, `job-facts-${Date.now()}.json`)
    const script = `
      const { spawn } = require('node:child_process')
      const { writeFileSync } = require('node:fs')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
      writeFileSync(${JSON.stringify(factsFile)}, JSON.stringify({ cwd: process.cwd(), value: process.env.TARGET_VALUE, arg: process.argv[1] }))
      child.unref()
      process.exit(42)
    `
    const request = spec([process.execPath, '-e', script, 'literal $HOME ${UNCHANGED}'], 100, { TARGET_VALUE: 'explicit' })
    const handle = bindManagedProcess(request, launchWindowsJob(request))
    const descendant = await waitForPid(pidFile)
    try {
      await expect(handle.done).resolves.toEqual({ exitCode: 42, signal: null })
      expect(readFileSync(factsFile, 'utf8')).toBe(JSON.stringify({
        cwd: scratch,
        value: 'explicit',
        arg: 'literal $HOME ${UNCHANGED}',
      }))
      await expect(handle.waitForExit(AbortSignal.timeout(30))).resolves.toBe(false)
      handle.terminate()
      await expect(handle.waitForExit()).resolves.toBe(true)
      await waitGone(descendant)
    } finally {
      cleanup(descendant)
    }
  })

  it('preserves missing-target and invalid-executable rejection errors', async () => {
    const missing = spec([`missing-native-target-${Date.now()}.exe`])
    const missingHandle = bindManagedProcess(missing, launchWindowsJob(missing))
    await expect(missingHandle.done).rejects.toMatchObject({ code: 'ENOENT' })

    const invalidExecutable = join(scratch, `direct-${Date.now()}.exe`)
    writeFileSync(invalidExecutable, 'not a Windows executable\r\n')
    const directError = await directSpawnFailure([invalidExecutable])
    const invalid = spec([invalidExecutable])
    const invalidHandle = bindManagedProcess(invalid, launchWindowsJob(invalid))
    await expect(invalidHandle.done).rejects.toMatchObject({ code: directError.code })
  })
})
