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
  it('forwards target pid publication after the handle is returned', async () => {
    const target = { pid: undefined as number | undefined }
    const handle = bindManagedProcess({
      ...spec(),
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    }, {
      stdin: null,
      stdout: null,
      stderr: null,
      get pid() { return target.pid },
      direct: Promise.resolve({ exitCode: 0, signal: null }),
      owner: { signal: vi.fn(), waitForExit: async () => {} },
    })

    expect(handle.pid).toBeUndefined()
    target.pid = 4242
    expect(handle.pid).toBe(4242)
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('does not miss an abort between the initial check and listener registration', async () => {
    let aborted = false
    const addEventListener = vi.fn(() => { aborted = true })
    const removeEventListener = vi.fn()
    const signal = {
      get aborted() { return aborted },
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal

    await expect(waitWithAbort(new Promise<void>(() => {}), signal)).resolves.toBe(false)
    expect(addEventListener).toHaveBeenCalledOnce()
    expect(removeEventListener).toHaveBeenCalledOnce()
  })

  it('contains owner failure after an already-aborted wait returns false', async () => {
    const controller = new AbortController()
    const ownerFailure = Promise.withResolvers<undefined>()
    controller.abort()

    await expect(waitWithAbort(ownerFailure.promise, controller.signal)).resolves.toBe(false)
    ownerFailure.reject(new Error('owner unavailable'))
    await new Promise(resolve => setImmediate(resolve))
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
      async waitForExit() {
        if (ownerStopped) return
        await stopped.promise
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
      owner: { signal, waitForExit: async () => {} },
    })
    handle.terminateForHostExit()
    expect(signal).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })

  it.each([
    ['raw', 'pipe'],
    ['collected', { maxBytes: 1024 }],
  ] as const)('waits for %s output EOF after the direct outcome', async (_label, stdoutMode) => {
    const stdout = new PassThrough()
    const direct = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
    const request = {
      ...spec(1_000),
      stdio: { stdin: 'ignore', stdout: stdoutMode, stderr: 'inherit' } as const,
    }
    const handle = bindManagedProcess(request, {
      stdin: null,
      stdout,
      stderr: null,
      pid: 4242,
      direct: direct.promise,
      owner: { signal: vi.fn(), waitForExit: async () => {} },
    })
    if (stdoutMode === 'pipe') stdout.resume()
    let doneSettled = false
    void handle.done.then(() => { doneSettled = true })
    direct.resolve({ exitCode: 23, signal: null })
    await new Promise(resolve => setImmediate(resolve))
    expect(doneSettled).toBe(false)
    stdout.end()
    await expect(Promise.race([
      handle.done,
      new Promise<'timeout'>(resolve => setTimeout(() => { resolve('timeout') }, 100)),
    ])).resolves.toEqual({ exitCode: 23, signal: null })
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
      pid: wrapper.pid,
      direct: direct.promise,
      owner: { signal: vi.fn(), waitForExit: async () => {} },
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

  it('retries termination after an expired escalation and range-observation rejection', async () => {
    vi.useFakeTimers()
    const failure = new Error('range observation failed')
    const firstObservation = Promise.withResolvers<undefined>()
    const secondObservation = Promise.withResolvers<undefined>()
    const waitForExit = vi.fn()
      .mockImplementationOnce(() => firstObservation.promise)
      .mockImplementationOnce(() => secondObservation.promise)
    const signal = vi.fn()
    const handle = bindManagedProcess({
      ...spec(),
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    }, {
      stdin: null,
      stdout: null,
      stderr: null,
      pid: 4242,
      direct: new Promise(() => {}),
      owner: { signal, waitForExit },
    })
    try {
      handle.terminate()
      const firstWait = handle.waitForExit()
      expect(signal.mock.calls).toEqual([['SIGTERM']])
      await vi.advanceTimersByTimeAsync(30)
      expect(signal.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
      firstObservation.reject(failure)
      await expect(firstWait).rejects.toBe(failure)

      handle.terminate()
      const secondWait = handle.waitForExit()
      expect(signal.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGTERM']])
      await vi.advanceTimersByTimeAsync(30)
      expect(signal.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGTERM'], ['SIGKILL']])
      secondObservation.resolve(undefined)
      await expect(secondWait).resolves.toBe(true)
      expect(waitForExit).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
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
      pid: wrapper.pid,
      direct,
      owner: { signal, waitForExit: async () => {} },
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
      pid: wrapper.pid,
      direct: direct.promise,
      owner: {
        signal,
        waitForExit: async () => { await stopped.promise },
      },
    })
    direct.resolve({ exitCode: 0, signal: null })
    await handle.done
    controller.abort()
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(signal).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })
})
