import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { launchLinuxScope, probeLinuxScope } from '../src/linux-scope.ts'
import { bindManagedProcess } from '../src/spawn.ts'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-native-containment-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

function spec(argv: string[], graceMs = 100): SubprocessSpawnSpec {
  return {
    argv,
    cwd: scratch,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs,
  }
}

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, 'utf8').trim())
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch {
      // The target has not written the file yet.
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
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
        const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
        if (state === 'Z' || state === 'X') return
      } catch {
        return
      }
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`pid ${pid} remained alive`)
}

const linuxNative = process.platform === 'linux' && probeLinuxScope()

describe.skipIf(!linuxNative)('Linux user-systemd native containment', () => {
  it('terminates a setsid descendant and waits for the scope to become empty', async () => {
    const pidFile = join(scratch, `setsid-${Date.now()}.pid`)
    const command = `setsid sh -c 'echo $$ > "$1"; trap "" TERM; while :; do sleep 60; done' sh ${JSON.stringify(pidFile)} & wait`
    const handle = bindManagedProcess(spec(['bash', '-c', command], 80), launchLinuxScope(spec(['bash', '-c', command], 80)))
    const descendant = await waitForPid(pidFile)
    handle.terminate()
    await handle.done
    await expect(handle.waitForExit()).resolves.toBe(true)
    await waitGone(descendant)
  })

  it('preserves Node-shaped ENOENT and EACCES spawn failures without replay', async () => {
    const missing = spec([`missing-native-target-${Date.now()}`])
    const missingHandle = bindManagedProcess(missing, launchLinuxScope(missing))
    await expect(missingHandle.done).rejects.toMatchObject({ code: 'ENOENT' })

    const deniedPath = join(scratch, `not-executable-${Date.now()}`)
    writeFileSync(deniedPath, '#!/bin/sh\nexit 0\n', { mode: 0o600 })
    chmodSync(deniedPath, 0o600)
    const denied = spec([deniedPath])
    const deniedHandle = bindManagedProcess(denied, launchLinuxScope(denied))
    await expect(deniedHandle.done).rejects.toMatchObject({ code: 'EACCES' })
  })
})
