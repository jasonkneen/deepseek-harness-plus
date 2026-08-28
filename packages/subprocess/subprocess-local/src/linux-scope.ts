/** Linux user-systemd scope launch and managed-range ownership. */

import { execFile, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { setTimeout as sleepMs } from 'node:timers/promises'
import type {
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { BoundProcessOwner, ManagedProcessLaunch } from './managed-owner.ts'
import {
  cleanupLinuxLaunchFiles,
  createLinuxLaunchFiles,
  deserializeRunnerError,
  readLinuxStartupError,
} from './runner-protocol.ts'
import type { LinuxLaunchFiles } from './runner-protocol.ts'
import {
  runnerEnvironment,
  runnerInvocationAvailable,
  runnerStdio,
  spawnRunnerInvocation,
} from './runner-launch.ts'
import type { RunnerInvocation } from './runner-launch.ts'
import { childEnv } from './spawn.ts'

/** Test seams for systemd command execution. */
export interface LinuxScopeInternals {
  spawn?: typeof spawn
  spawnSync?: typeof spawnSync
  systemctlQuery?: (command: string, args: readonly string[]) => Promise<SystemctlResult>
  systemdRun?: string
  systemctl?: string
  runnerInvocation?: RunnerInvocation
  resolveRunnerInvocation?: () => RunnerInvocation
  runnerAvailable?: (invocation: RunnerInvocation) => boolean
  execveAvailable?: boolean
}

interface SystemctlResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

const SYSTEMCTL_TIMEOUT_MS = 5_000
const SCOPE_POLL_INTERVAL_MS = 50
const MISSING_UNIT = /\bunit\b[^\r\n]*(?:could not be found|not found|not loaded)/iu

function systemctlEnv(): NodeJS.ProcessEnv {
  return childEnv({ LC_ALL: 'C', SYSTEMD_LOG_TARGET: 'null' })
}

function querySystemctl(command: string, args: readonly string[]): Promise<SystemctlResult> {
  return new Promise((resolveResult) => {
    execFile(command, [...args], {
      encoding: 'utf8',
      env: systemctlEnv(),
      timeout: SYSTEMCTL_TIMEOUT_MS,
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : (error as Error & { code?: string | number }).code
      resolveResult({
        status: typeof code === 'number' ? code : null,
        stdout,
        stderr,
        ...error === null ? {} : { error },
      })
    })
  })
}

function unitStem(prefix: string): string {
  return `${prefix}-${String(process.pid)}-${randomBytes(6).toString('hex')}`
}

/**
 * Confirm that the live user manager is readable for this spawn.
 * @param internals - optional command seams used by tests.
 * @returns whether the current user manager answered successfully.
 */
export function probeLinuxUserManager(internals: LinuxScopeInternals = {}): boolean {
  const result = (internals.spawnSync ?? spawnSync)(
    internals.systemctl ?? 'systemctl',
    ['--user', 'show-environment'],
    { env: systemctlEnv(), stdio: 'ignore', timeout: SYSTEMCTL_TIMEOUT_MS },
  )
  return result.error === undefined && result.status === 0
}

/**
 * Confirm this exact runner entry and Node execve support without a probe mode.
 * @param internals - optional runner and execve seams used by tests.
 * @returns whether the bootstrap can enter the final target.
 */
export function probeLinuxBootstrap(internals: LinuxScopeInternals = {}): boolean {
  if (!(internals.execveAvailable ?? typeof process.execve === 'function')) return false
  try {
    const invocation = internals.runnerInvocation
      ?? (internals.resolveRunnerInvocation ?? spawnRunnerInvocation)()
    return (internals.runnerAvailable ?? runnerInvocationAvailable)(invocation)
  } catch {
    return false
  }
}

/**
 * Confirm current literal-argv transient-scope support before selecting native launch.
 * @param internals - optional systemd command seams used by tests.
 * @returns whether the current user manager supports the required scope invocation.
 */
export function probeLinuxScope(internals: LinuxScopeInternals = {}): boolean {
  const unitBase = unitStem('dsh-subprocess-probe')
  const result = (internals.spawnSync ?? spawnSync)(internals.systemdRun ?? 'systemd-run', [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    '--expand-environment=no',
    `--unit=${unitBase}`,
    '--',
    internals.systemctl ?? 'systemctl',
    '--user',
    'show',
    `${unitBase}.scope`,
    '--property=ActiveState',
    '--value',
  ], { env: systemctlEnv(), stdio: 'ignore', timeout: SYSTEMCTL_TIMEOUT_MS })
  return result.error === undefined && result.status === 0
}

/**
 * Re-check every Linux native prerequisite for one eligible spawn.
 * @param internals - optional native capability seams used by tests.
 * @returns whether the Linux native containment path is currently available.
 */
export function probeLinuxNative(internals: LinuxScopeInternals = {}): boolean {
  return probeLinuxBootstrap(internals)
    && probeLinuxUserManager(internals)
    && probeLinuxScope(internals)
}

interface DirectRange {
  running(): boolean
  signal(signal: 'SIGTERM' | 'SIGKILL'): void
}

class SystemdScopeOwner implements BoundProcessOwner {
  private established = false
  private stopped = false
  private observation: Promise<void> | undefined
  private killFailure: Error | undefined

  constructor(
    private readonly unit: string,
    private readonly files: LinuxLaunchFiles,
    private readonly direct: DirectRange,
    private readonly systemctl: string,
    private readonly runSync: typeof spawnSync,
    private readonly query: (command: string, args: readonly string[]) => Promise<SystemctlResult>,
  ) {}

  signal(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.stopped) return
    this.direct.signal(signal)
    const result = this.runSync(this.systemctl, [
      '--user',
      'kill',
      '--kill-whom=all',
      `--signal=${signal}`,
      this.unit,
    ], { encoding: 'utf8', env: systemctlEnv(), timeout: SYSTEMCTL_TIMEOUT_MS })
    if (result.error === undefined && result.status === 0) {
      if (signal === 'SIGKILL') this.killFailure = undefined
      return
    }
    if (signal === 'SIGKILL') {
      const output = `${result.stdout}\n${result.stderr}`
      if (!MISSING_UNIT.test(output)) {
        this.killFailure = result.error ?? new Error(
          `systemctl could not signal ${this.unit}: ${output.trim() || `exit ${String(result.status)}`}`,
        )
      }
    }
  }

  terminateForHostExit(): void {
    if (this.stopped) return
    try { this.direct.signal('SIGKILL') } catch { /* Continue with the native owner. */ }
    try {
      this.runSync(this.systemctl, [
        '--user',
        'kill',
        '--kill-whom=all',
        '--signal=SIGKILL',
        this.unit,
      ], { env: systemctlEnv(), stdio: 'ignore', timeout: SYSTEMCTL_TIMEOUT_MS })
    } catch {
      // Host exit cannot report one range; the runtime continues with the rest.
    }
  }

  private async rangeActive(): Promise<boolean> {
    if (!existsSync(this.files.requestPath)) this.established = true
    const result = await this.query(this.systemctl, [
      '--user',
      'show',
      this.unit,
      '--property=ActiveState',
      '--value',
    ])
    const output = `${result.stdout}\n${result.stderr}`
    if (result.status === 0) {
      this.established = true
      const state = result.stdout.trim()
      if (state === 'inactive' || state === 'failed') return false
      if (state !== 'active' && state !== 'activating' && state !== 'deactivating') {
        throw new Error(`systemctl returned unknown ActiveState for ${this.unit}: ${JSON.stringify(state)}`)
      }
      if (this.killFailure !== undefined) throw this.killFailure
      return true
    }
    if (!MISSING_UNIT.test(output)) {
      if (result.error !== undefined) throw result.error
      throw new Error(`systemctl could not read ${this.unit}: ${output.trim() || `exit ${String(result.status)}`}`)
    }
    if (this.established) return false
    if (!this.direct.running() && existsSync(this.files.requestPath)) {
      throw new Error(`subprocess scope ${this.unit} ended before consuming its launch request`)
    }
    if (this.killFailure !== undefined) throw this.killFailure
    return true
  }

  async waitForExit(): Promise<void> {
    if (this.stopped) return
    this.observation ??= (async () => {
      while (await this.rangeActive()) await sleepMs(SCOPE_POLL_INTERVAL_MS)
      this.stopped = true
    })().catch((error: unknown) => {
      this.observation = undefined
      throw error
    })
    await this.observation
  }

  cleanup(): void {
    cleanupLinuxLaunchFiles(this.files)
  }
}

function scopeArgs(unitBase: string, invocation: RunnerInvocation, argv: readonly string[]): string[] {
  return [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    '--expand-environment=no',
    `--unit=${unitBase}`,
    '--',
    ...invocation,
    '--',
    ...argv,
  ]
}

function directOutcome(
  child: ReturnType<typeof spawn>,
  files: LinuxLaunchFiles,
): Promise<SubprocessOutcome> {
  return new Promise((resolveOutcome, rejectOutcome) => {
    let settled = false
    child.once('error', (error) => {
      if (settled) return
      settled = true
      rejectOutcome(error)
    })
    child.once('exit', (exitCode, signal) => {
      if (settled) return
      settled = true
      try {
        const startup = readLinuxStartupError(files.startupErrorPath)
        if (startup !== undefined) {
          rejectOutcome(deserializeRunnerError(startup.error))
          return
        }
        if (existsSync(files.requestPath)) {
          rejectOutcome(new Error('subprocess scope exited before its bootstrap consumed the launch request'))
          return
        }
        resolveOutcome({ exitCode, signal })
      } catch (error) {
        /* v8 ignore next -- Node filesystem operations throw Error instances. */
        const failure = error instanceof Error ? error : new Error(String(error))
        rejectOutcome(failure)
      }
    })
  })
}

function signalChildGroup(child: ReturnType<typeof spawn>, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* The direct process already exited. */ }
  }
}

/** Linux PTY invocation and owner for the exact one-shot scope/bootstrap. */
export interface LinuxTerminalScopeLaunch {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  bindOwner: (direct: DirectRange) => BoundProcessOwner
  resolveOutcome: (outcome: SubprocessOutcome) => SubprocessOutcome
  cleanup: () => void
}

/**
 * Prepare one Linux PTY scope using the same launch request and bootstrap core.
 * @param spec - terminal target request.
 * @param targetEnv - validated complete target environment.
 * @param internals - optional runner and systemd seams used by tests.
 * @returns invocation facts and ownership callbacks for node-pty.
 */
export function prepareLinuxTerminalScope(
  spec: SubprocessTerminalSpawnSpec,
  targetEnv: Record<string, string>,
  internals: LinuxScopeInternals = {},
): LinuxTerminalScopeLaunch {
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const files = createLinuxLaunchFiles({ cwd: spec.cwd, env: targetEnv })
  const unitBase = unitStem('dsh-terminal')
  return {
    command: internals.systemdRun ?? 'systemd-run',
    args: scopeArgs(unitBase, invocation, spec.argv),
    cwd: process.cwd(),
    env: runnerEnvironment(files.requestPath),
    bindOwner: direct => new SystemdScopeOwner(
      `${unitBase}.scope`,
      files,
      direct,
      internals.systemctl ?? 'systemctl',
      internals.spawnSync ?? spawnSync,
      internals.systemctlQuery ?? querySystemctl,
    ),
    resolveOutcome: (outcome) => {
      const startup = readLinuxStartupError(files.startupErrorPath)
      if (startup !== undefined) throw deserializeRunnerError(startup.error)
      if (existsSync(files.requestPath)) {
        throw new Error('terminal scope exited before its bootstrap consumed the launch request')
      }
      return outcome
    },
    cleanup: () => { cleanupLinuxLaunchFiles(files) },
  }
}

/**
 * Launch one ordinary target inside a transient user scope.
 * @param spec - ordinary target request.
 * @param targetEnv - validated complete target environment.
 * @param internals - optional runner and systemd seams used by tests.
 * @returns direct streams, result, and managed-scope owner.
 */
export function launchLinuxScope(
  spec: SubprocessSpawnSpec,
  targetEnv: Record<string, string>,
  internals: LinuxScopeInternals = {},
): ManagedProcessLaunch {
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const files = createLinuxLaunchFiles({ cwd: spec.cwd, env: targetEnv })
  const unitBase = unitStem('dsh-subprocess')
  let child: ReturnType<typeof spawn>
  try {
    child = (internals.spawn ?? spawn)(internals.systemdRun ?? 'systemd-run', scopeArgs(
      unitBase,
      invocation,
      spec.argv,
    ), {
      cwd: process.cwd(),
      env: runnerEnvironment(files.requestPath),
      stdio: runnerStdio(spec, false),
      detached: true,
    })
  } catch (error) {
    cleanupLinuxLaunchFiles(files)
    throw error
  }
  const owner = new SystemdScopeOwner(
    `${unitBase}.scope`,
    files,
    {
      running: () => child.pid !== undefined && child.exitCode === null && child.signalCode === null,
      signal: (signal) => { signalChildGroup(child, signal) },
    },
    internals.systemctl ?? 'systemctl',
    internals.spawnSync ?? spawnSync,
    internals.systemctlQuery ?? querySystemctl,
  )
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    direct: directOutcome(child, files),
    owner,
  }
}
