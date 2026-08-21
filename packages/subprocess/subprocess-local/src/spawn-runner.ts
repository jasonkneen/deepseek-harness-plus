/** Native managed-range runner for ordinary local subprocesses. */

import { spawn } from 'node:child_process'
import {
  closeHandleChecked,
  loadWin32ProcessBindings,
  openNamedPipeForStdio,
  openJobForAssignment,
  spawnOrdinaryProcessInJob,
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
    jobName: string
    stdinPipe?: string
    stdoutPipe?: string
    stderrPipe?: string
  }

function parseArgs(argv: string[]): RunnerArgs {
  let mode: string | undefined
  let jobName: string | undefined
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
    else if (key === '--job') jobName = value
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
  if (mode === 'win32') {
    if (jobName === undefined || jobName.length === 0) throw new Error('subprocess runner requires a Windows Job name')
    return {
      mode,
      requestPath,
      eventsPath,
      jobName,
      ...stdinPipe === undefined ? {} : { stdinPipe },
      ...stdoutPipe === undefined ? {} : { stdoutPipe },
      ...stderrPipe === undefined ? {} : { stderrPipe },
    }
  }
  return { mode, requestPath, eventsPath }
}

function win32SpawnError(error: unknown, request: RunnerRequest): SerializedSpawnError {
  const serialized = serializeSpawnError(error)
  const code = error instanceof Win32Error
    ? error.win32Code === 2 || error.win32Code === 3 || error.win32Code === 267
      ? 'ENOENT'
      : error.win32Code === 5
        ? 'EPERM'
        : error.win32Code === 193
          ? 'EFTYPE'
          : 'UNKNOWN'
    : serialized.code
  if (code === undefined) return serialized
  const program = request.argv[0] as string
  return {
    ...serialized,
    name: serialized.name,
    message: `spawn ${program} ${code}: ${serialized.message}`,
    code,
    syscall: `spawn ${program}`,
    path: program,
    spawnargs: request.argv.slice(1),
  }
}

function runNode(request: RunnerRequest, eventsPath: string): void {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => { /* The scope target receives it; the runner stays to report direct outcome. */ })
  }
  const [program, ...args] = request.argv
  const child = spawn(program as string, args, {
    cwd: request.cwd,
    env: request.env,
    stdio: 'inherit',
  })
  let started = false
  let failed = false
  child.once('spawn', () => {
    started = true
    appendRunnerEvent(eventsPath, { type: 'started', pid: child.pid as number })
  })
  child.once('error', (error) => {
    failed = true
    if (!started) appendRunnerEvent(eventsPath, { type: 'spawn-error', error: serializeSpawnError(error) })
    else appendRunnerEvent(eventsPath, { type: 'runner-error', error: serializeSpawnError(error) })
    process.exitCode = 127
  })
  child.once('exit', (exitCode, signal) => {
    if (failed) return
    appendRunnerEvent(eventsPath, { type: 'exit', exitCode, signal })
    process.exitCode = exitCode ?? 1
  })
}

function replaceEnvironment(env: Record<string, string>): void {
  for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key)
  Object.assign(process.env, env)
}

function closeStdioHandles(
  api: ReturnType<typeof loadWin32ProcessBindings>,
  handles: Array<{ handle: NativePtr; label: string }>,
  reportFailure: boolean,
): void {
  let failure: Error | undefined
  for (const { handle, label } of handles.splice(0)) {
    try {
      closeHandleChecked(api, handle, label)
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error))
    }
  }
  if (reportFailure && failure !== undefined) throw failure
}

async function runWin32(
  request: RunnerRequest,
  eventsPath: string,
  jobName: string,
  pipes: Pick<Extract<RunnerArgs, { mode: 'win32' }>, 'stdinPipe' | 'stdoutPipe' | 'stderrPipe'>,
): Promise<void> {
  replaceEnvironment(request.env)
  const api = loadWin32ProcessBindings()
  let processHandle: NativePtr | undefined
  let jobHandle: NativePtr | undefined
  let targetStarted = false
  let targetCreationAttempted = false
  const openedStdio: Array<{ handle: NativePtr; label: string }> = []
  try {
    if (!process.connected) throw new Error('Windows subprocess runner requires a parent IPC channel')
    const released = new Promise<void>((resolve) => { process.once('disconnect', resolve) })
    jobHandle = openJobForAssignment(api, jobName)
    const stdio: ChildStdioHandles = {}
    for (const [key, path] of [
      ['stdin', pipes.stdinPipe],
      ['stdout', pipes.stdoutPipe],
      ['stderr', pipes.stderrPipe],
    ] as const) {
      if (path === undefined) continue
      const handle = openNamedPipeForStdio(api, path)
      stdio[key] = handle
      openedStdio.push({ handle, label: `ordinary target ${key} pipe` })
    }
    // Node attributes an invalid cwd to the attempted target spawn rather
    // than exposing the launcher's internal chdir operation.
    targetCreationAttempted = true
    process.chdir(request.cwd)
    const [command, ...args] = request.argv
    const spawned = spawnOrdinaryProcessInJob(
      api,
      { command: command as string, args, cwd: process.cwd() },
      jobHandle,
      stdio,
    )
    processHandle = spawned.process
    targetStarted = true
    closeStdioHandles(api, openedStdio, true)
    closeHandleChecked(api, jobHandle, 'ordinary process Job assignment')
    jobHandle = undefined
    appendRunnerEvent(eventsPath, { type: 'started', pid: spawned.pid })
    await released
    const directProcess = processHandle
    processHandle = undefined
    closeHandleChecked(api, directProcess, 'ordinary direct process handoff')
  } catch (error) {
    appendRunnerEvent(eventsPath, {
      type: targetStarted ? 'runner-error' : 'spawn-error',
      error: targetStarted || !targetCreationAttempted
        ? serializeSpawnError(error)
        : win32SpawnError(error, request),
    })
    process.exitCode = 127
  } finally {
    closeStdioHandles(api, openedStdio, false)
    if (processHandle !== undefined) {
      try { closeHandleChecked(api, processHandle, 'ordinary direct process cleanup') } catch { /* best effort after reported failure */ }
    }
    if (jobHandle !== undefined) {
      try { closeHandleChecked(api, jobHandle, 'ordinary process Job cleanup') } catch { /* best effort after reported failure */ }
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.mode === 'probe-node') return
  if (args.mode === 'probe-win32') {
    loadWin32ProcessBindings()
    return
  }
  const request = consumeRunnerRequest(args.requestPath)
  if (args.mode === 'node') runNode(request, args.eventsPath)
  else {
    try {
      await runWin32(request, args.eventsPath, args.jobName, args)
    } finally {
      if (process.connected) process.disconnect()
    }
  }
}

main().catch((error: unknown) => {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.mode !== 'probe-node' && args.mode !== 'probe-win32') {
      appendRunnerEvent(args.eventsPath, { type: 'runner-error', error: serializeSpawnError(error) })
    }
  } catch {
    // No trustworthy transport remains; the parent reports the missing result.
  }
  process.exitCode = 127
})
