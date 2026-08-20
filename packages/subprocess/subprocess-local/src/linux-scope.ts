/** Linux user-systemd scope launch and managed-range ownership. */

import { randomBytes } from 'node:crypto'
import { execFile, spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { setTimeout as sleepMs } from 'node:timers/promises'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { BoundProcessOwner, ManagedProcessLaunch } from './managed-owner.ts'
import { observeChildClose, waitWithAbort } from './managed-owner.ts'
import { childEnv } from './spawn.ts'
import {
  cleanupAfterRunner,
  runnerDirectResult,
  runnerFiles,
  runnerStdio,
  spawnRunnerInvocation,
} from './runner-launch.ts'

/** Test seams for systemd command execution. */
export interface LinuxScopeInternals {
  spawn?: typeof spawn
  spawnSync?: typeof spawnSync
  systemctlQuery?: (command: string, args: readonly string[]) => Promise<SystemctlResult>
  systemdRun?: string
  systemctl?: string
  runnerInvocation?: string[]
}

interface SystemctlResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

const SYSTEMCTL_TIMEOUT_MS = 5_000
const SCOPE_POLL_INTERVAL_MS = 200
const MISSING_UNIT = /\bunit\b[^\r\n]*(?:could not be found|not found|not loaded)/iu

function systemctlEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: 'C' }
}

function querySystemctl(command: string, args: readonly string[]): Promise<SystemctlResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], {
      encoding: 'utf8',
      env: systemctlEnv(),
      timeout: SYSTEMCTL_TIMEOUT_MS,
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : (error as Error & { code?: string | number }).code
      resolve({
        status: typeof code === 'number' ? code : null,
        stdout,
        stderr,
        ...error === null ? {} : { error },
      })
    })
  })
}

function unitStem(prefix: string): string {
  return `${prefix}-${process.pid}-${randomBytes(6).toString('hex')}`
}

/**
 * Confirm a modern readable user manager and literal-argument scope launch.
 * @param internals - injected command paths and runners.
 * @returns true only before any user command is selected for native launch.
 */
export function probeLinuxScope(internals: LinuxScopeInternals = {}): boolean {
  const runSync = internals.spawnSync ?? spawnSync
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const [runnerCommand, ...runnerPrefix] = invocation
  if (runnerCommand === undefined) return false
  const systemdRun = internals.systemdRun ?? 'systemd-run'
  const systemctl = internals.systemctl ?? 'systemctl'
  const timeout = 5_000
  const manager = runSync(systemctl, ['--user', 'show-environment'], {
    encoding: 'utf8',
    env: systemctlEnv(),
    stdio: 'ignore',
    timeout,
  })
  if (manager.error !== undefined || manager.status !== 0) return false
  const probe = runSync(systemdRun, [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    '--expand-environment=no',
    `--unit=${unitStem('dsh-subprocess-probe')}`,
    '--',
    runnerCommand,
    ...runnerPrefix,
    '--mode',
    'probe-node',
  ], {
    env: childEnv(),
    stdio: 'ignore',
    timeout,
  })
  return probe.error === undefined && probe.status === 0
}

class SystemdScopeOwner implements BoundProcessOwner {
  private stopped = false
  private observation: Promise<void> | undefined
  private killConfirmed = false
  private killFailure: Error | undefined

  constructor(
    private readonly unit: string,
    private readonly systemctl: string,
    private readonly runSync: typeof spawnSync,
    private readonly query: (command: string, args: readonly string[]) => Promise<SystemctlResult>,
    private readonly runner: ChildProcess,
  ) {}

  signal(signal: NodeJS.Signals): void {
    if (this.stopped) return
    const result = this.runSync(this.systemctl, [
      '--user',
      'kill',
      '--kill-whom=all',
      `--signal=${signal}`,
      this.unit,
    ], { encoding: 'utf8', env: systemctlEnv(), timeout: SYSTEMCTL_TIMEOUT_MS })
    if (result.error === undefined && result.status === 0) {
      if (signal === 'SIGKILL') this.killConfirmed = true
      return
    }
    if (signal === 'SIGKILL') {
      const output = `${result.stdout}\n${result.stderr}`
      this.killFailure = result.error ?? new Error(
        `systemctl could not signal ${this.unit}: ${output.trim() || `exit ${String(result.status)}`}`,
      )
    }
  }

  private async active(): Promise<boolean> {
    const result = await this.query(this.systemctl, [
      '--user',
      'show',
      this.unit,
      '--property=ActiveState',
      '--value',
    ])
    const output = `${result.stdout}\n${result.stderr}`
    if (result.status !== 0) {
      if (MISSING_UNIT.test(output)) {
        if (this.runner.pid === undefined || this.runner.exitCode !== null || this.runner.signalCode !== null) return false
      } else {
        if (result.error !== undefined) throw result.error
        throw new Error(`systemctl could not read ${this.unit}: ${output.trim() || `exit ${String(result.status)}`}`)
      }
    } else {
      const state = result.stdout.trim()
      if (state === 'inactive' || state === 'failed') return false
      if (state !== 'active' && state !== 'activating' && state !== 'deactivating') {
        throw new Error(`systemctl returned unknown ActiveState for ${this.unit}: ${JSON.stringify(state)}`)
      }
    }
    if (this.killFailure !== undefined) throw this.killFailure
    return true
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.stopped) return true
    this.observation ??= (async () => {
      while (await this.active()) await sleepMs(SCOPE_POLL_INTERVAL_MS)
      this.stopped = true
    })()
    return waitWithAbort(this.observation, signal)
  }

  forcedOutcome(): { exitCode: null; signal: 'SIGKILL' } | undefined {
    return this.killConfirmed ? { exitCode: null, signal: 'SIGKILL' } : undefined
  }
}

/**
 * Launch one direct command inside a transient user scope.
 * @param spec - exact target argv, cwd, stdio, environment, and lifecycle settings.
 * @param internals - injected command runners used by platform tests.
 * @returns wrapper streams, target outcome, and the bound scope owner.
 */
export function launchLinuxScope(
  spec: SubprocessSpawnSpec,
  internals: LinuxScopeInternals = {},
): ManagedProcessLaunch {
  const run = internals.spawn ?? spawn
  const runSync = internals.spawnSync ?? spawnSync
  const query = internals.systemctlQuery ?? querySystemctl
  const systemdRun = internals.systemdRun ?? 'systemd-run'
  const systemctl = internals.systemctl ?? 'systemctl'
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const files = runnerFiles(spec)
  const unitBase = unitStem('dsh-subprocess')
  const child = run(systemdRun, [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    '--expand-environment=no',
    `--unit=${unitBase}`,
    '--',
    ...invocation,
    '--mode',
    'node',
    '--request',
    files.requestPath,
    '--events',
    files.eventsPath,
  ], {
    env: childEnv(),
    stdio: runnerStdio(spec),
  })
  const closed = observeChildClose(child)
  const owner = new SystemdScopeOwner(`${unitBase}.scope`, systemctl, runSync, query, child)
  const result = runnerDirectResult(child, files, closed, () => owner.forcedOutcome())
  cleanupAfterRunner(files, result.direct, closed)
  return { child, pid: result.pid, direct: result.direct, closed, owner }
}
