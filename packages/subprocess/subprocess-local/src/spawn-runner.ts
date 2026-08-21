/** Native managed-range runner for ordinary local subprocesses. */

import { spawn } from 'node:child_process'
import {
  closeHandleChecked,
  loadWin32ProcessBindings,
  openJobForAssignment,
  pollProcessExit,
  spawnOrdinaryProcessInJob,
  Win32Error,
} from '@deepseek-ai/dsh-win32-process'
import type { NativePtr } from '@deepseek-ai/dsh-win32-process'
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
  | { mode: 'win32'; requestPath: string; eventsPath: string; jobName: string }

function parseArgs(argv: string[]): RunnerArgs {
  let mode: string | undefined
  let jobName: string | undefined
  let requestPath: string | undefined
  let eventsPath: string | undefined
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`subprocess runner missing value after ${String(key)}`)
    if (key === '--mode') mode = value
    else if (key === '--job') jobName = value
    else if (key === '--request') requestPath = value
    else if (key === '--events') eventsPath = value
    else throw new Error(`subprocess runner unknown argument: ${String(key)}`)
  }
  if (mode === 'probe-node' || mode === 'probe-win32') return { mode }
  if (mode !== 'node' && mode !== 'win32') throw new Error(`subprocess runner unknown mode: ${String(mode)}`)
  if (requestPath === undefined || eventsPath === undefined) throw new Error('subprocess runner requires request and event paths')
  if (mode === 'win32') {
    if (jobName === undefined || jobName.length === 0) throw new Error('subprocess runner requires a Windows Job name')
    return { mode, requestPath, eventsPath, jobName }
  }
  return { mode, requestPath, eventsPath }
}

function win32SpawnError(error: unknown, request: RunnerRequest): SerializedSpawnError {
  if (!(error instanceof Win32Error)) return serializeSpawnError(error)
  const code = error.win32Code === 2 || error.win32Code === 3 || error.win32Code === 267
    ? 'ENOENT'
    : error.win32Code === 5
      ? 'EPERM'
      : error.win32Code === 193
        ? 'EFTYPE'
        : 'UNKNOWN'
  const program = request.argv[0] as string
  return {
    name: 'Error',
    message: `spawn ${program} ${code}: ${error.message}`,
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

async function runWin32(request: RunnerRequest, eventsPath: string, jobName: string): Promise<void> {
  replaceEnvironment(request.env)
  const api = loadWin32ProcessBindings()
  let processHandle: NativePtr | undefined
  let jobHandle: NativePtr | undefined
  let targetStarted = false
  try {
    process.chdir(request.cwd)
    jobHandle = openJobForAssignment(api, jobName)
    const [command, ...args] = request.argv
    const spawned = spawnOrdinaryProcessInJob(api, { command: command as string, args, cwd: process.cwd() }, jobHandle)
    processHandle = spawned.process
    targetStarted = true
    closeHandleChecked(api, jobHandle, 'ordinary process Job assignment')
    jobHandle = undefined
    appendRunnerEvent(eventsPath, { type: 'started', pid: spawned.pid })

    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        try {
          if (processHandle !== undefined) {
            const exitCode = pollProcessExit(api, processHandle)
            if (exitCode !== undefined) {
              appendRunnerEvent(eventsPath, { type: 'exit', exitCode, signal: null })
              closeHandleChecked(api, processHandle, 'ordinary direct process')
              processHandle = undefined
              clearInterval(timer)
              resolve()
            }
          }
        } catch (error) {
          clearInterval(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }, 10)
    })
  } catch (error) {
    appendRunnerEvent(eventsPath, {
      type: targetStarted ? 'runner-error' : 'spawn-error',
      error: targetStarted ? serializeSpawnError(error) : win32SpawnError(error, request),
    })
    process.exitCode = 127
  } finally {
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
  else await runWin32(request, args.eventsPath, args.jobName)
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
