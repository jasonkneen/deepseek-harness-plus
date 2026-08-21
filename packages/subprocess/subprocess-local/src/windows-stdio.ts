/** Parent-owned named-pipe streams for one Windows native launch. */

import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import type { Readable, Writable } from 'node:stream'
import type { StdioOptions } from 'node:child_process'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

interface PipeEndpoint {
  readonly path: string
  readonly stream: PassThrough
  dispose(): void
}

/** Streams and runner arguments for one Windows launch. */
export interface WindowsStdioBridge {
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  readonly runnerArgs: string[]
  readonly runnerStdio: StdioOptions
  closeInput(): void
  dispose(): void
}

function closeServer(server: Server): void {
  try {
    server.close()
  } catch {
    // A listen failure or an already-accepted connection can close first.
  }
}

function createEndpoint(path: string, direction: 'input' | 'output'): PipeEndpoint {
  const stream = new PassThrough()
  let socket: Socket | undefined
  let disposed = false
  const server = createServer({ allowHalfOpen: true })
  // Direct-result failure remains authoritative for setup errors. Keep the
  // stream error observable without allowing an early server failure to become
  // an unhandled process-level exception before bindManagedProcess attaches.
  stream.on('error', () => {})
  server.once('error', (error) => { stream.destroy(error) })
  server.once('connection', (connection) => {
    if (disposed) {
      connection.destroy()
      return
    }
    socket = connection
    closeServer(server)
    connection.once('error', (error) => { stream.destroy(error) })
    stream.once('close', () => { connection.destroy() })
    if (direction === 'output') {
      connection.once('end', () => { connection.end() })
      connection.pipe(stream)
    } else {
      connection.resume()
      stream.pipe(connection)
      connection.once('end', () => {
        stream.unpipe(connection)
        connection.end()
        stream.destroy()
      })
      connection.once('close', () => { stream.destroy() })
    }
  })
  try {
    server.listen(path)
  } catch (error) {
    stream.destroy()
    closeServer(server)
    throw error
  }
  return {
    path,
    stream,
    dispose() {
      disposed = true
      closeServer(server)
      socket?.destroy()
      stream.destroy()
    },
  }
}

/**
 * Create private parent-owned streams whose peer handles are opened by the Windows runner.
 * @param spec - target stdio dispositions.
 * @param basePath - unique named-pipe base chosen by the launch owner.
 * @returns public streams, runner arguments, and cleanup for pre-start failure.
 */
export function createWindowsStdioBridge(
  spec: SubprocessSpawnSpec,
  basePath: string,
): WindowsStdioBridge {
  const endpoints: PipeEndpoint[] = []
  let stdin: PipeEndpoint | undefined
  let stdout: PipeEndpoint | undefined
  let stderr: PipeEndpoint | undefined
  try {
    if (spec.stdio.stdin !== 'ignore') {
      stdin = createEndpoint(`${basePath}-stdin`, 'input')
      endpoints.push(stdin)
    }
    if (spec.stdio.stdout !== 'inherit') {
      stdout = createEndpoint(`${basePath}-stdout`, 'output')
      endpoints.push(stdout)
    }
    if (spec.stdio.stderr !== 'inherit') {
      stderr = createEndpoint(`${basePath}-stderr`, 'output')
      endpoints.push(stderr)
    }
  } catch (error) {
    for (const endpoint of endpoints) endpoint.dispose()
    throw error
  }
  return {
    stdin: stdin?.stream ?? null,
    stdout: stdout?.stream ?? null,
    stderr: stderr?.stream ?? null,
    runnerArgs: [
      ...stdin === undefined ? [] : ['--stdin-pipe', stdin.path],
      ...stdout === undefined ? [] : ['--stdout-pipe', stdout.path],
      ...stderr === undefined ? [] : ['--stderr-pipe', stderr.path],
    ],
    runnerStdio: [
      'ignore',
      spec.stdio.stdout === 'inherit' ? 'inherit' : 'ignore',
      spec.stdio.stderr === 'inherit' ? 'inherit' : 'ignore',
      'ipc',
    ],
    closeInput() {
      stdin?.dispose()
    },
    dispose() {
      for (const endpoint of endpoints) endpoint.dispose()
    },
  }
}
