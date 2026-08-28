import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'

const roots: string[] = []

function projectWithHost(source: string): string {
  const project = mkdtempSync(join(tmpdir(), 'dsh-desktop-host-test-'))
  roots.push(project)
  const packageRoot = join(project, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"@deepseek-ai/dsh","type":"module"}\n')
  writeFileSync(join(packageRoot, 'lib', 'desktop-host.js'), source)
  return project
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop host process', () => {
  it('carries a streaming response and shuts the child down cleanly', async () => {
    const project = projectWithHost(`
process.send({ type: 'ready', protocolVersion: 2, dshVersion: process.env.NODE_OPTIONS ?? 'clean' })
process.on('message', message => {
  if (message.type === 'fetch') {
    process.send({ type: 'response-start', id: message.id, status: 200, headers: [['content-type', 'text/plain']] })
    process.send({ type: 'response-chunk', id: message.id, chunkBase64: Buffer.from('desktop').toString('base64') })
    process.send({ type: 'response-end', id: message.id })
  } else if (message.type === 'shutdown') {
    process.disconnect()
  }
})
`)
    const previous = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = '--require /path/that/must/not/reach/the/child'
    const host = new DesktopHostProcess(process.execPath, project)
    try {
      await expect(host.start()).resolves.toMatchObject({ dshVersion: 'clean' })
      const response = await host.fetch(new Request('dsh-app://app/example'))
      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe('desktop')
      await expect(host.stop()).resolves.toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previous
      await host.stop().catch(() => undefined)
    }
  })

  it('accepts a large canonical base64 response chunk without recursive RegExp validation', async () => {
    const size = 2 * 1024 * 1024
    const project = projectWithHost(`
process.send({ type: 'ready', protocolVersion: 2, dshVersion: 'large-chunk' })
process.on('message', message => {
  if (message.type === 'fetch') {
    process.send({ type: 'response-start', id: message.id, status: 200, headers: [] })
    process.send({ type: 'response-chunk', id: message.id, chunkBase64: Buffer.alloc(${String(2 * 1024 * 1024)}, 97).toString('base64') })
    process.send({ type: 'response-end', id: message.id })
  } else if (message.type === 'shutdown') {
    process.disconnect()
  }
})
`)
    const host = new DesktopHostProcess(process.execPath, project)
    try {
      const response = await host.fetch(new Request('dsh-app://app/large'))
      const body = new Uint8Array(await response.arrayBuffer())
      expect(body).toHaveLength(size)
      expect(body[0]).toBe(97)
      expect(body.at(-1)).toBe(97)
    } finally {
      await host.stop().catch(() => undefined)
    }
  })

  it('ignores a response end that arrives after the renderer cancels its stream', async () => {
    const project = projectWithHost(`
process.send({ type: 'ready', protocolVersion: 2, dshVersion: 'cancel-race' })
process.on('message', message => {
  if (message.type === 'fetch') {
    process.send({ type: 'response-start', id: message.id, status: 200, headers: [] })
    if (message.request.url.endsWith('/after')) {
      process.send({ type: 'response-chunk', id: message.id, chunkBase64: Buffer.from('alive').toString('base64') })
      process.send({ type: 'response-end', id: message.id })
    }
  } else if (message.type === 'cancel') {
    process.send({ type: 'response-end', id: message.id })
  } else if (message.type === 'shutdown') {
    process.disconnect()
  }
})
`)
    const host = new DesktopHostProcess(process.execPath, project)
    try {
      const canceled = await host.fetch(new Request('dsh-app://app/cancel'))
      await canceled.body?.cancel()
      await new Promise(resolve => setTimeout(resolve, 25))
      const after = await host.fetch(new Request('dsh-app://app/after'))
      await expect(after.text()).resolves.toBe('alive')
    } finally {
      await host.stop().catch(() => undefined)
    }
  })

  it('rejects an invalid event and a clean exit before readiness', async () => {
    const invalid = new DesktopHostProcess(process.execPath, projectWithHost(`
process.send({ type: 'ready', protocolVersion: 99, dshVersion: '1.0.0' })
setInterval(() => {}, 1000)
`))
    await expect(invalid.start()).rejects.toThrow(/invalid IPC event/u)
    await invalid.stop().catch(() => undefined)

    const earlyExit = new DesktopHostProcess(process.execPath, projectWithHost('process.exit(0)\n'))
    await expect(earlyExit.start()).rejects.toThrow(/stopped/u)
  })
})
