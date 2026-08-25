/** Native managed-range runner for ordinary local subprocesses. */

import { spawn } from 'node:child_process'
import {
  closeHandleChecked,
  isJobEmpty,
  loadWin32ProcessBindings,
  openNamedPipeForStdio,
  pollProcessExit,
  spawnCurrentTokenJobProcess,
  terminateJob,
  waitForProcessExit,
  Win32Error,
} from '@deepseek-ai/dsh-win32-process'
import type { ChildStdioHandles, NativePtr } from '@deepseek-ai/dsh-win32-process'
import {
  appendRunnerEvent,
  consumeRunnerRequest,
  serializeSpawnError,
} from './runner-protocol.ts'
import type { RunnerRequest, SerializedSpawnError } from './runner-protocol.ts'

type RunnerArgs =
  | { mode: 'probe-node' }
  | { mode: 'probe-win32' }
  | { mode: 'node'; requestPath: string; eventsPath: string }
  | {
    mode: 'win32'
    requestPath: string
    eventsPath: string
    stdinPipe?: string
    stdoutPipe?: string
    stderrPipe?: string
  }

type RunnerHost = Pick<
  NodeJS.Process,
  'env' | 'exitCode' | 'connected' | 'cwd' | 'chdir' | 'on' | 'off' | 'disconnect'
>

interface RunnerInternals {
  spawn: typeof spawn
  loadWin32ProcessBindings: typeof loadWin32ProcessBindings
  openNamedPipeForStdio: typeof openNamedPipeForStdio
  spawnCurrentTokenJobProcess: typeof spawnCurrentTokenJobProcess
  pollProcessExit: typeof pollProcessExit
  isJobEmpty: typeof isJobEmpty
  terminateJob: typeof terminateJob
  waitForProcessExit: typeof waitForProcessExit
  closeHandleChecked: typeof closeHandleChecked
}

const defaultRunnerInternals: RunnerInternals = {
  spawn,
  loadWin32ProcessBindings,
  openNamedPipeForStdio,
  spawnCurrentTokenJobProcess,
  pollProcessExit,
  isJobEmpty,
  terminateJob,
  waitForProcessExit,
  closeHandleChecked,
}

function parseArgs(argv: string[]): RunnerArgs {
  let mode: string | undefined
  let requestPath: string | undefined
  let eventsPath: string | undefined
  let stdinPipe: string | undefined
  let stdoutPipe: string | undefined
  let stderrPipe: string | undefined
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`subprocess runner missing value after ${String(key)}`)
    if (key === '--mode') mode = value
    else if (key === '--request') requestPath = value
    else if (key === '--events') eventsPath = value
    else if (key === '--stdin-pipe') stdinPipe = value
    else if (key === '--stdout-pipe') stdoutPipe = value
    else if (key === '--stderr-pipe') stderrPipe = value
    else throw new Error(`subprocess runner unknown argument: ${String(key)}`)
  }
  if (mode === 'probe-node' || mode === 'probe-win32') return { mode }
  if (mode !== 'node' && mode !== 'win32') throw new Error(`subprocess runner unknown mode: ${String(mode)}`)
  if (requestPath === undefined || eventsPath === undefined) throw new Error('subprocess runner requires request and event paths')
  if (mode === 'node') return { mode, requestPath, eventsPath }
  return {
    mode,
    requestPath,
    eventsPath,
    ...stdinPipe === undefined ? {} : { stdinPipe },
    ...stdoutPipe === undefined ? {} : { stdoutPipe },
    ...stderrPipe === undefined ? {} : { stderrPipe },
  }
}

function win32SpawnError(error: unknown, request: RunnerRequest): SerializedSpawnError {
  const serialized = serializeSpawnError(error)
  const code = error instanceof Win32Error
    ? error.win32Code === 2 || error.win32Code === 3 || error.win32Code === 267
      ? 'ENOENT'
      : error.win32Code === 5
        ? 'EACCES'
        : error.win32Code === 193
          ? 'EFTYPE'
          : 'UNKNOWN'
    : serialized.code
  if (code === undefined) return serialized
  const program = request.argv[0] as string
  return {
    ...serialized,
    message: `spawn ${program} ${code}: ${serialized.message}`,
    code,
    syscall: `spawn ${program}`,
    path: program,
    spawnargs: request.argv.slice(1),
  }
}

async function runNode(
  request: RunnerRequest,
  eventsPath: string,
  host: RunnerHost,
  internals: RunnerInternals,
): Promise<void> {
  const ignoreScopeSignal = (): void => { /* The target receives the scope signal; the runner reports its outcome. */ }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    host.on(signal, ignoreScopeSignal)
  }
  const [program, ...args] = request.argv
  const child = internals.spawn(program as string, args, {
    cwd: request.cwd,
    env: request.env,
    stdio: 'inherit',
  })
  await new Promise<void>((resolve) => {
    let started = false
    let failed = false
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) host.off(signal, ignoreScopeSignal)
      resolve()
    }
    child.once('spawn', () => {
      started = true
      appendRunnerEvent(eventsPath, { type: 'started', pid: child.pid as number })
    })
    child.once('error', (error) => {
      failed = true
      if (!started) appendRunnerEvent(eventsPath, { type: 'spawn-error', error: serializeSpawnError(error) })
      else appendRunnerEvent(eventsPath, { type: 'runner-error', error: serializeSpawnError(error) })
      host.exitCode = 127
      finish()
    })
    child.once('exit', (exitCode, signal) => {
      if (!failed) {
        appendRunnerEvent(eventsPath, { type: 'exit', exitCode, signal })
        host.exitCode = exitCode ?? 1
      }
      finish()
    })
  })
}

function replaceEnvironment(target: NodeJS.ProcessEnv, env: Record<string, string>): void {
  for (const key of Object.keys(target)) Reflect.deleteProperty(target, key)
  Object.assign(target, env)
}

function closeStdioHandles(
  api: ReturnType<typeof loadWin32ProcessBindings>,
  handles: Array<{ handle: NativePtr; label: string }>,
  reportFailure: boolean,
  internals: RunnerInternals,
): void {
  let failure: Error | undefined
  for (const owned of handles.splice(0)) {
    try {
      internals.closeHandleChecked(api, owned.handle, owned.label)
    } catch (error) {
      handles.push(owned)
      failure ??= error instanceof Error ? error : new Error(serializeSpawnError(error).message)
    }
  }
  if (reportFailure && failure !== undefined) throw failure
}

async function runWin32(
  request: RunnerRequest,
  eventsPath: string,
  pipes: Pick<Extract<RunnerArgs, { mode: 'win32' }>, 'stdinPipe' | 'stdoutPipe' | 'stderrPipe'>,
  host: RunnerHost,
  internals: RunnerInternals,
): Promise<void> {
  replaceEnvironment(host.env, request.env)
  const api = internals.loadWin32ProcessBindings()
  let processHandle: NativePtr | undefined
  let jobHandle: NativePtr | undefined
  const openedStdio: Array<{ handle: NativePtr; label: string }> = []
  try {
    const stdio: ChildStdioHandles = {}
    for (const [key, path, access] of [
      ['stdin', pipes.stdinPipe, 'read'],
      ['stdout', pipes.stdoutPipe, 'write'],
      ['stderr', pipes.stderrPipe, 'write'],
    ] as const) {
      if (path === undefined) continue
      const handle = internals.openNamedPipeForStdio(api, path, access)
      stdio[key] = handle
      openedStdio.push({ handle, label: `ordinary target ${key} pipe` })
    }
    // Match Node's cwd-relative executable lookup and spawn-error attribution.
    const runnerCwd = host.cwd()
    host.chdir(request.cwd)
    try {
      const [command, ...args] = request.argv
      const spawned = internals.spawnCurrentTokenJobProcess(
        api,
        { command: command as string, args, cwd: host.cwd() },
        stdio,
      )
      processHandle = spawned.process
      jobHandle = spawned.job
      appendRunnerEvent(eventsPath, { type: 'started', pid: spawned.pid })
    } finally {
      host.chdir(runnerCwd)
    }
    closeStdioHandles(api, openedStdio, true, internals)

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let terminationRequested = false
      const settle = (error?: unknown): void => {
        if (settled) return
        settled = true
        clearInterval(timer)
        host.off('message', onMessage)
        host.off('disconnect', onDisconnect)
        if (error === undefined) resolve()
        else reject(error instanceof Error ? error : new Error(serializeSpawnError(error).message))
      }
      const terminate = (): void => {
        if (terminationRequested || jobHandle === undefined) return
        terminationRequested = true
        try {
          internals.terminateJob(api, jobHandle, 1)
        } catch (error) {
          settle(error)
        }
      }
      const onMessage = (message: unknown): void => {
        if (message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'terminate') {
          terminate()
        }
      }
      const onDisconnect = (): void => { terminate() }
      host.on('message', onMessage)
      host.on('disconnect', onDisconnect)
      const timer = setInterval(() => {
        try {
          if (processHandle !== undefined) {
            const exitCode = internals.pollProcessExit(api, processHandle)
            if (exitCode !== undefined) {
              appendRunnerEvent(eventsPath, { type: 'exit', exitCode, signal: null })
              internals.closeHandleChecked(api, processHandle, 'ordinary direct process')
              processHandle = undefined
            }
          }
          if (processHandle === undefined && jobHandle !== undefined && internals.isJobEmpty(api, jobHandle)) {
            internals.closeHandleChecked(api, jobHandle, 'ordinary process Job')
            jobHandle = undefined
            settle()
          }
        } catch (error) {
          settle(error)
        }
      }, 10)
    })
  } catch (error) {
    const targetSpawnFailed = (error instanceof Win32Error && error.api === 'CreateProcessW')
      || (processHandle === undefined
        && error instanceof Error
        && (error as NodeJS.ErrnoException).syscall === 'chdir')
    appendRunnerEvent(eventsPath, {
      type: targetSpawnFailed ? 'spawn-error' : 'runner-error',
      error: targetSpawnFailed ? win32SpawnError(error, request) : serializeSpawnError(error),
    })
    if (!targetSpawnFailed) host.exitCode = 127
  } finally {
    closeStdioHandles(api, openedStdio, false, internals)
    if (processHandle !== undefined) {
      try { internals.closeHandleChecked(api, processHandle, 'ordinary direct process cleanup') } catch { /* best effort after reported failure */ }
    }
    if (jobHandle !== undefined) {
      try { internals.closeHandleChecked(api, jobHandle, 'ordinary process Job cleanup') } catch { /* best effort after reported failure */ }
    }
  }
}

function probeWin32Job(host: RunnerHost, internals: RunnerInternals): void {
  const command = host.env.ComSpec ?? host.env.COMSPEC
  if (command === undefined) throw new Error('subprocess runner cannot probe a Windows Job without ComSpec')
  const api = internals.loadWin32ProcessBindings()
  const spawned = internals.spawnCurrentTokenJobProcess(api, {
    command,
    args: ['/d', '/s', '/c', 'exit 0'],
    cwd: host.cwd(),
  })
  try {
    const exitCode = internals.waitForProcessExit(api, spawned.process)
    if (exitCode !== 0) throw new Error(`subprocess Windows Job probe exited with code ${String(exitCode)}`)
  } finally {
    internals.closeHandleChecked(api, spawned.job, 'subprocess Windows Job probe')
  }
}

/**
 * Execute one parsed private-runner request.
 * @param argv - runner arguments after the executable and entry path.
 * @param host - process operations; tests provide an isolated host facade.
 * @param internals - platform operations; tests replace native Win32 calls.
 * @returns after the requested probe or target lifecycle completes.
 */
export async function runSpawnRunner(
  argv: string[],
  host: RunnerHost = process,
  internals: RunnerInternals = defaultRunnerInternals,
): Promise<void> {
  const args = parseArgs(argv)
  if (args.mode === 'probe-node') return
  if (args.mode === 'probe-win32') {
    probeWin32Job(host, internals)
    return
  }
  const request = consumeRunnerRequest(args.requestPath)
  if (args.mode === 'node') await runNode(request, args.eventsPath, host, internals)
  else {
    try {
      await runWin32(request, args.eventsPath, args, host, internals)
    } finally {
      if (host.connected) host.disconnect()
    }
  }
}

/**
 * Publish an infrastructure failure when runner arguments still identify an event file.
 * @param argv - original runner arguments.
 * @param error - uncaught runner failure.
 */
export function reportSpawnRunnerFailure(argv: string[], error: unknown): void {
  try {
    const args = parseArgs(argv)
    if (args.mode !== 'probe-node' && args.mode !== 'probe-win32') {
      appendRunnerEvent(args.eventsPath, { type: 'runner-error', error: serializeSpawnError(error) })
    }
  } catch {
    // No trustworthy transport remains; the parent reports the missing result.
  }
}
