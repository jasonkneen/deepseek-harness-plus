import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  launchWindowsJob,
  probeWindowsJob,
} from '../src/windows-job.ts'
import { bindManagedProcess } from '../src/spawn.ts'

class FakeChild extends EventEmitter {
  pid: number | undefined = 432
  connected = true
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  targetStdin = new PassThrough()
  targetStdout = new PassThrough()
  targetStderr = new PassThrough()
  stdio = [null, null, null, null, this.targetStdin, this.targetStdout, this.targetStderr]
  sent: unknown[] = []
  killed: NodeJS.Signals[] = []
  sendError: Error | undefined
  throwOnSendCall: number | undefined
  sendThrown: unknown = new Error('send threw')
  private sendCalls = 0

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sendCalls += 1
    if (this.sendCalls === this.throwOnSendCall) throw this.sendThrown
    this.sent.push(message)
    queueMicrotask(() => { callback?.(this.sendError ?? null) })
    return true
  }
  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal)
    return true
  }
}

const spec = {
  argv: ['tool.exe', 'literal arg'],
  cwd: 'C:\\target',
  env: { TARGET: 'yes' },
  stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
  graceMs: 100,
} as const

function launch(child = new FakeChild()) {
  const spawn = vi.fn(() => child)
  const result = launchWindowsJob(spec, { TARGET: 'yes' }, {
    spawn: spawn as never,
    runnerInvocation: ['C:\\node.exe', 'C:\\runner.js'],
  })
  return { child, result, spawn }
}

describe('Windows Job capability', () => {
  it('uses the production dependency paths by default', async () => {
    vi.resetModules()
    const child = new FakeChild()
    const spawn = vi.fn(() => child)
    const load = vi.fn(() => ({ bindings: true }) as never)
    const probe = vi.fn()
    vi.doMock('node:child_process', async importOriginal => ({
      ...await importOriginal<typeof import('node:child_process')>(),
      spawn,
    }))
    vi.doMock('@deepseek-ai/dsh-win32-process', () => ({
      loadWin32ProcessBindings: load,
      probeCurrentTokenJobSupport: probe,
    }))
    try {
      const isolated = await import('../src/windows-job.ts')
      expect(isolated.probeWindowsJob()).toBe(true)
      expect(load).toHaveBeenCalledOnce()
      expect(probe).toHaveBeenCalledOnce()

      const result = isolated.launchWindowsJob(spec, { TARGET: 'yes' })
      expect(spawn).toHaveBeenCalledOnce()
      child.emit('message', { type: 'target-exit', exitCode: 0, signal: null })
      child.connected = false
      child.emit('close', 0, null)
      await expect(result.direct).resolves.toEqual({ exitCode: 0, signal: null })
      await expect(result.owner.waitForExit()).resolves.toBeUndefined()
    } finally {
      vi.doUnmock('node:child_process')
      vi.doUnmock('@deepseek-ai/dsh-win32-process')
      vi.resetModules()
    }
  })

  it('rechecks runner and empty Job support on every eligible spawn', () => {
    const runnerAvailable = vi.fn(() => true)
    const load = vi.fn(() => ({ bindings: true }) as never)
    const probe = vi.fn()
    const inputs = {
      runnerInvocation: ['C:\\node.exe', 'C:\\runner.js'] as [string, ...string[]],
      runnerAvailable,
      loadWin32ProcessBindings: load,
      probeCurrentTokenJobSupport: probe,
    }
    expect(probeWindowsJob(inputs)).toBe(true)
    expect(probeWindowsJob(inputs)).toBe(true)
    expect(runnerAvailable).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('falls back when either runner or current Job capability is unavailable', () => {
    expect(probeWindowsJob({
      resolveRunnerInvocation: () => { throw new Error('runner resolution failed') },
    })).toBe(false)
    expect(probeWindowsJob({ runnerInvocation: ['/missing'], runnerAvailable: () => false })).toBe(false)
    expect(probeWindowsJob({
      runnerInvocation: ['C:\\node.exe'],
      runnerAvailable: () => true,
      loadWin32ProcessBindings: () => { throw new Error('bindings missing') },
    })).toBe(false)
  })
})

describe('Windows parent runner contract', () => {
  it('isolates runner stdio, carries target stdio on fd 4 through fd 6, and sends cwd/env', () => {
    const { child, result, spawn } = launch()
    expect(spawn).toHaveBeenCalledWith('C:\\node.exe', [
      'C:\\runner.js', '--', 'tool.exe', 'literal arg',
    ], expect.objectContaining({
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe', 2],
    }))
    expect(child.sent).toEqual([{ type: 'start', cwd: 'C:\\target', env: { TARGET: 'yes' } }])
    expect(result.stdin).toBe(child.targetStdin)
    expect(result.stdout).toBe(child.targetStdout)
    expect(result.stderr).toBe(child.targetStderr)
  })

  it('maps target-exit to direct outcome and clean close to range quiescence', async () => {
    const { child, result } = launch()
    child.emit('message', { type: 'target-exit', exitCode: 7, signal: null })
    await expect(result.direct).resolves.toEqual({ exitCode: 7, signal: null })
    child.connected = false
    child.emit('close', 0, null)
    await expect(result.owner.waitForExit()).resolves.toBeUndefined()
  })

  it('rejects done when runner failure precedes stdio settlement', async () => {
    const { child, result } = launch()
    const handle = bindManagedProcess(spec, result)
    child.emit('message', { type: 'target-exit', exitCode: 7, signal: null })
    await Promise.resolve()
    child.connected = false
    child.emit('close', 127, null)
    await expect(handle.done).rejects.toThrow('exit code 127')
  })

  it('maps spawn-error and start-cancelled without requiring public target identity', async () => {
    const spawned = launch()
    spawned.child.emit('message', {
      type: 'spawn-error', error: { name: 'Error', message: 'missing', code: 'ENOENT' },
    })
    await expect(spawned.result.direct).rejects.toMatchObject({ code: 'ENOENT' })
    spawned.child.connected = false
    spawned.child.emit('close', 0, null)
    await expect(spawned.result.owner.waitForExit()).resolves.toBeUndefined()

    const cancelled = launch()
    const reason = new Error('caller aborted')
    cancelled.result.owner.signal('SIGTERM', reason)
    expect(cancelled.child.sent.at(-1)).toEqual({ type: 'terminate' })
    cancelled.child.emit('message', { type: 'start-cancelled' })
    await expect(cancelled.result.direct).rejects.toBe(reason)
    cancelled.child.connected = false
    cancelled.child.emit('close', 0, null)
    await expect(cancelled.result.owner.waitForExit()).resolves.toBeUndefined()

    const implicit = launch()
    implicit.child.emit('message', { type: 'start-cancelled' })
    await expect(implicit.result.direct).rejects.toThrow('target start was cancelled')
    implicit.child.connected = false
    implicit.child.emit('close', 0, null)
    await expect(implicit.result.owner.waitForExit()).resolves.toBeUndefined()
  })

  it('rejects direct and wait for runner-error or abnormal runner exit', async () => {
    const failed = launch()
    failed.child.emit('message', {
      type: 'runner-error', error: { name: 'Error', message: 'Job assignment failed' },
    })
    await expect(failed.result.direct).rejects.toThrow('Job assignment failed')
    failed.child.connected = false
    failed.child.emit('close', 127, null)
    await expect(failed.result.owner.waitForExit()).rejects.toThrow('exit code 127')
    await expect(failed.result.infrastructureFailure).rejects.toThrow('exit code 127')

    const missing = launch()
    missing.child.connected = false
    missing.child.emit('close', null, 'SIGKILL')
    await expect(missing.result.direct).rejects.toThrow('signal SIGKILL')

    const statusless = launch()
    statusless.child.connected = false
    statusless.child.emit('close', null, null)
    await expect(statusless.result.direct).rejects.toThrow('without an exit status')
  })

  it('fails closed on malformed/duplicate result, runner spawn error, and start-send error', async () => {
    const malformed = launch()
    malformed.child.emit('message', { type: 'target-exit', exitCode: -1, signal: null })
    expect(malformed.child.killed).toEqual(['SIGKILL'])
    await expect(malformed.result.infrastructureFailure).rejects.toThrow('invalid target-exit')

    const duplicate = launch()
    duplicate.child.emit('message', { type: 'target-exit', exitCode: 0, signal: null })
    duplicate.child.emit('message', { type: 'target-exit', exitCode: 0, signal: null })
    await expect(duplicate.result.infrastructureFailure).rejects.toThrow('more than one direct result')
    duplicate.child.connected = false
    duplicate.child.emit('close', 127, null)
    await expect(duplicate.result.owner.waitForExit()).rejects.toThrow('exit code 127')

    const errored = launch()
    const spawnError = new Error('runner executable missing')
    errored.child.emit('error', spawnError)
    await expect(errored.result.direct).rejects.toBe(spawnError)
    await expect(errored.result.owner.waitForExit()).rejects.toBe(spawnError)

    const sendFailedChild = new FakeChild()
    sendFailedChild.sendError = new Error('IPC send failed')
    const sendFailed = launch(sendFailedChild)
    await expect(sendFailed.result.direct).rejects.toThrow('IPC send failed')
    await expect(sendFailed.result.infrastructureFailure).rejects.toThrow('IPC send failed')
    expect(sendFailedChild.killed).toEqual(['SIGKILL'])

    const noIpc = new FakeChild()
    Object.defineProperty(noIpc, 'send', { value: undefined })
    const noIpcResult = launch(noIpc).result
    await expect(noIpcResult.direct).rejects.toThrow('has no IPC channel')
    await expect(noIpcResult.infrastructureFailure).rejects.toThrow('has no IPC channel')

    const nonError = new FakeChild()
    nonError.throwOnSendCall = 1
    nonError.sendThrown = 'start send failed'
    const nonErrorResult = launch(nonError).result
    await expect(nonErrorResult.direct).rejects.toThrow('start send failed')
    await expect(nonErrorResult.infrastructureFailure).rejects.toThrow('start send failed')
  })

  it('fails infrastructure and kills the runner when termination delivery fails', async () => {
    const callback = launch()
    await Promise.resolve()
    callback.child.sendError = new Error('terminate callback failed')
    callback.result.owner.signal('SIGTERM')
    await expect(callback.result.infrastructureFailure).rejects.toThrow('terminate callback failed')
    expect(callback.child.killed).toEqual(['SIGKILL'])
    callback.child.connected = false
    callback.child.emit('close', 127, null)
    await expect(callback.result.direct).rejects.toThrow('exit code 127')

    const throwingChild = new FakeChild()
    throwingChild.throwOnSendCall = 2
    throwingChild.sendThrown = 'terminate send threw'
    const throwing = launch(throwingChild)
    throwing.result.owner.signal('SIGTERM')
    await expect(throwing.result.infrastructureFailure).rejects.toThrow('terminate send threw')
    expect(throwing.child.killed).toEqual(['SIGKILL'])

    const errorChild = new FakeChild()
    errorChild.throwOnSendCall = 2
    const error = launch(errorChild)
    error.result.owner.signal('SIGTERM')
    await expect(error.result.infrastructureFailure).rejects.toThrow('send threw')
  })

  it('uses synchronous runner termination for host exit and isolates repeated control', () => {
    const { child, result } = launch()
    result.owner.signal('SIGTERM', new Error('first'))
    result.owner.signal('SIGKILL', new Error('second'))
    expect(child.sent.filter(message => (message as { type?: string }).type === 'terminate')).toHaveLength(1)
    result.owner.terminateForHostExit()
    expect(child.killed).toEqual(['SIGKILL'])
  })
})
