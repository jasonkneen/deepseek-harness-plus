import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { BoundProcessOwner } from '../src/managed-owner.ts'
import { waitWithAbort } from '../src/managed-owner.ts'
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
  it('closes the abort race after installing the wait listener', async () => {
    let reads = 0
    const removeEventListener = vi.fn()
    const signal = {
      get aborted() {
        reads += 1
        return reads > 1
      },
      addEventListener: vi.fn(),
      removeEventListener,
    } as unknown as AbortSignal

    await expect(waitWithAbort(new Promise<void>(() => {}), signal)).resolves.toBe(false)
    expect(removeEventListener).toHaveBeenCalledOnce()
  })

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
      stdin: wrapper.stdin,
      stdout: wrapper.stdout,
      stderr: wrapper.stderr,
      pid: 4242,
      direct: direct.promise,
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
      stdin: wrapper.stdin,
      stdout: wrapper.stdout,
      stderr: wrapper.stderr,
      pid: 4242,
      direct: Promise.resolve({ exitCode: 0, signal: null }),
      owner: { signal, waitForExit: async () => true },
    })
    handle.terminateForHostExit()
    expect(signal).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })

  it('settles when collected streams close before the direct outcome arrives', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const direct = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
    const handle = bindManagedProcess(spec(), {
      stdin: null,
      stdout,
      stderr,
      pid: 4242,
      direct: direct.promise,
      owner: { signal: vi.fn(), waitForExit: async () => true },
    })
    stdout.end()
    stderr.end()
    await new Promise(resolve => setImmediate(resolve))
    direct.resolve({ exitCode: 23, signal: null })
    await expect(handle.done).resolves.toEqual({ exitCode: 23, signal: null })
  })

  it('publishes direct outcome immediately when no collected stream needs draining', async () => {
    const wrapper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    const direct = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
    const handle = bindManagedProcess({
      ...spec(1_000),
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    }, {
      stdin: wrapper.stdin,
      stdout: wrapper.stdout,
      stderr: wrapper.stderr,
      pid: wrapper.pid as number,
      direct: direct.promise,
      owner: { signal: vi.fn(), waitForExit: async () => true },
    })
    try {
      direct.resolve({ exitCode: 23, signal: null })
      const outcome = await Promise.race([
        handle.done,
        new Promise<'timeout'>(resolve => setTimeout(() => { resolve('timeout') }, 50)),
      ])
      expect(outcome).toEqual({ exitCode: 23, signal: null })
    } finally {
      wrapper.kill('SIGKILL')
    }
  })

  it('contains background range-observation rejection until waitForExit observes it', async () => {
    const wrapper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const failure = new Error('range observation failed')
    const handle = bindManagedProcess(spec(), {
      stdin: wrapper.stdin,
      stdout: wrapper.stdout,
      stderr: wrapper.stderr,
      pid: wrapper.pid as number,
      direct: new Promise(() => {}),
      owner: { signal: vi.fn(), waitForExit: async () => { throw failure } },
    })
    try {
      handle.terminate()
      await new Promise(resolve => setImmediate(resolve))
      await expect(handle.waitForExit()).rejects.toBe(failure)
    } finally {
      wrapper.kill('SIGKILL')
    }
  })

  it('normalizes a non-Error direct rejection', async () => {
    const wrapper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const rejection: unknown = 'runner failed'
    const direct = Promise.resolve().then(() => { throw rejection })
    const signal = vi.fn()
    const handle = bindManagedProcess(spec(), {
      stdin: wrapper.stdin,
      stdout: wrapper.stdout,
      stderr: wrapper.stderr,
      pid: wrapper.pid as number,
      direct,
      owner: { signal, waitForExit: async () => true },
    })
    try {
      await expect(handle.done).rejects.toThrow('runner failed')
      expect(signal).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(wrapper.stdout?.destroyed).toBe(true)
      expect(wrapper.stderr?.destroyed).toBe(true)
    } finally {
      wrapper.kill('SIGKILL')
    }
  })

  it('keeps abort ownership after direct exit until the managed range is empty', async () => {
    const wrapper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const direct = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
    const stopped = Promise.withResolvers<undefined>()
    const signal = vi.fn((requested: NodeJS.Signals) => {
      if (requested !== 'SIGTERM') return
      wrapper.kill('SIGTERM')
      stopped.resolve(undefined)
    })
    const controller = new AbortController()
    const handle = bindManagedProcess({ ...spec(), signal: controller.signal }, {
      stdin: wrapper.stdin,
      stdout: wrapper.stdout,
      stderr: wrapper.stderr,
      pid: wrapper.pid as number,
      direct: direct.promise,
      owner: {
        signal,
        waitForExit: async () => { await stopped.promise; return true },
      },
    })
    direct.resolve({ exitCode: 0, signal: null })
    await handle.done
    controller.abort()
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(signal).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })
})
