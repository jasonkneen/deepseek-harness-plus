import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { connect } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { createWindowsStdioBridge } from '../src/windows-stdio.ts'

function pipeBase(): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-windows-stdio-test-${randomUUID()}`
    : join('/tmp', `dsh-windows-stdio-${randomUUID()}`)
}

function spec(): SubprocessSpawnSpec {
  return {
    argv: ['target'],
    cwd: process.cwd(),
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 1024 } },
    graceMs: 100,
  }
}

function pathAfter(args: readonly string[], key: string): string {
  const path = args[args.indexOf(key) + 1]
  if (path === undefined) throw new Error(`missing ${key}`)
  return path
}

describe('Windows parent-owned stdio bridge', () => {
  it('binds before returning so a synchronously launched peer can connect', async () => {
    const bridge = createWindowsStdioBridge({
      ...spec(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
    }, pipeBase())
    const stdoutPath = pathAfter(bridge.runnerArgs, '--stdout-pipe')
    const result = spawnSync(process.execPath, ['-e', `
      const { connect } = require('node:net')
      const socket = connect(${JSON.stringify(stdoutPath)})
      socket.once('connect', () => {
        socket.write('blocked-parent', () => {
          socket.destroy()
          process.exit(0)
        })
      })
      socket.once('error', () => { process.exit(1) })
      setTimeout(() => { process.exit(2) }, 2000)
    `], { timeout: 5_000 })
    expect(result.status).toBe(0)

    const chunks: Buffer[] = []
    bridge.stdout?.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    await once(bridge.stdout as NodeJS.ReadableStream, 'end')
    expect(Buffer.concat(chunks).toString()).toBe('blocked-parent')
    bridge.dispose()
  })

  it('moves bytes in both directions and ends output with its target-side peer', async () => {
    const bridge = createWindowsStdioBridge(spec(), pipeBase())
    const stdoutPath = pathAfter(bridge.runnerArgs, '--stdout-pipe')
    const stderrPath = pathAfter(bridge.runnerArgs, '--stderr-pipe')
    const stdinPath = pathAfter(bridge.runnerArgs, '--stdin-pipe')
    expect(bridge.runnerStdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc'])
    await new Promise(resolve => setImmediate(resolve))

    bridge.stdin?.end('in')
    const stdoutPeer = connect(stdoutPath)
    const stderrPeer = connect(stderrPath)
    const stdinPeer = connect(stdinPath)
    await Promise.all([once(stdoutPeer, 'connect'), once(stderrPeer, 'connect'), once(stdinPeer, 'connect')])

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const stdinChunks: Buffer[] = []
    bridge.stdout?.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk) })
    bridge.stderr?.on('data', (chunk: Buffer) => { stderrChunks.push(chunk) })
    stdinPeer.on('data', (chunk: Buffer) => { stdinChunks.push(chunk) })
    const stdoutEnded = once(bridge.stdout as NodeJS.ReadableStream, 'end')
    const stderrEnded = once(bridge.stderr as NodeJS.ReadableStream, 'end')
    const stdinEnded = once(stdinPeer, 'end')

    stdoutPeer.end('out')
    stderrPeer.end('err')
    await Promise.all([stdoutEnded, stderrEnded, stdinEnded])

    expect(Buffer.concat(stdoutChunks).toString()).toBe('out')
    expect(Buffer.concat(stderrChunks).toString()).toBe('err')
    expect(Buffer.concat(stdinChunks).toString()).toBe('in')
    bridge.dispose()
  })

  it('uses inherited output directly and disposes unconnected endpoints', () => {
    const inherited = createWindowsStdioBridge({
      ...spec(),
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    }, pipeBase())
    expect(inherited.stdin).toBeNull()
    expect(inherited.stdout).toBeNull()
    expect(inherited.stderr).toBeNull()
    expect(inherited.runnerArgs).toEqual([])
    expect(inherited.runnerStdio).toEqual(['ignore', 'inherit', 'inherit', 'ipc'])
    inherited.dispose()

    const pending = createWindowsStdioBridge(spec(), pipeBase())
    pending.closeInput()
    expect(pending.stdin?.destroyed).toBe(true)
    pending.dispose()
    expect(pending.stdout?.destroyed).toBe(true)
    expect(pending.stderr?.destroyed).toBe(true)
  })
})
