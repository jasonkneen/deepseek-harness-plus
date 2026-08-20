import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { BoundProcessOwner } from '../src/managed-owner.ts'
import { observeChildClose } from '../src/managed-owner.ts'
import { bindManagedProcess } from '../src/spawn.ts'

function spec(graceMs = 30): SubprocessSpawnSpec {
  return {
    argv: [process.execPath],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    graceMs,
  }
}

describe('managed process binding', () => {
  it('keeps direct outcome separate from managed-range quiescence', async () => {
    const wrapper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const direct = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
    const stopped = Promise.withResolvers<undefined>()
    let ownerStopped = false
    const signals: NodeJS.Signals[] = []
    const owner: BoundProcessOwner = {
      signal(signal) {
        if (ownerStopped) return
        signals.push(signal)
        if (signal === 'SIGKILL') {
          ownerStopped = true
          wrapper.kill('SIGKILL')
          stopped.resolve(undefined)
        }
      },
      async waitForExit(signal) {
        if (ownerStopped) return true
        if (signal?.aborted) return false
        if (signal === undefined) {
          await stopped.promise
          return true
        }
        const aborted = Promise.withResolvers<boolean>()
        signal.addEventListener('abort', () => { aborted.resolve(false) }, { once: true })
        return Promise.race([stopped.promise.then(() => true), aborted.promise])
      },
    }
    const handle = bindManagedProcess(spec(), {
      child: wrapper,
      pid: 4242,
      direct: direct.promise,
      closed: observeChildClose(wrapper),
      owner,
    })
    direct.resolve({ exitCode: 42, signal: null })
    await expect(handle.done).resolves.toEqual({ exitCode: 42, signal: null })

    const bound = AbortSignal.timeout(10)
    await expect(handle.waitForExit(bound)).resolves.toBe(false)
    handle.terminate()
    expect(signals).toEqual(['SIGTERM'])
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    await expect(handle.waitForExit()).resolves.toBe(true)
    handle.terminateForHostExit()
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('routes synchronous host-exit finalization directly to the owner', () => {
    const wrapper = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const signal = vi.fn()
    const handle = bindManagedProcess(spec(), {
      child: wrapper,
      pid: 4242,
      direct: Promise.resolve({ exitCode: 0, signal: null }),
      closed: observeChildClose(wrapper),
      owner: { signal, waitForExit: async () => true },
    })
    handle.terminateForHostExit()
    expect(signal).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })
})
