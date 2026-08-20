/** Linux user-systemd scope launch and managed-range ownership. */

import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
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
  systemdRun?: string
  systemctl?: string
  runnerInvocation?: string[]
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
  const systemdRun = internals.systemdRun ?? 'systemd-run'
  const systemctl = internals.systemctl ?? 'systemctl'
  const timeout = 5_000
  const manager = runSync(systemctl, ['--user', 'show-environment'], {
    encoding: 'utf8',
    stdio: 'ignore',
    timeout,
  })
  if (manager.error !== undefined || manager.status !== 0) return false
  const probe = runSync(systemdRun, [
    '--user',
    '--scope',
    '--quiet',
    '--wait',
    '--collect',
    '--pipe',
    '--expand-environment=no',
    `--unit=${unitStem('dsh-subprocess-probe')}`,
    '--',
    process.execPath,
    '-e',
    '',
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
  private lastSignal: NodeJS.Signals | undefined

  constructor(
    private readonly unit: string,
    private readonly systemctl: string,
    private readonly runSync: typeof spawnSync,
    private readonly runner: ChildProcess,
  ) {}

  signal(signal: NodeJS.Signals): void {
    if (this.stopped) return
    this.lastSignal = signal
    this.runSync(this.systemctl, [
      '--user',
      'kill',
      '--kill-whom=all',
      `--signal=${signal}`,
      this.unit,
    ], { stdio: 'ignore', timeout: 5_000 })
  }

  private active(): boolean {
    const result = this.runSync(this.systemctl, [
      '--user',
      'show',
      this.unit,
      '--property=ActiveState',
      '--value',
    ], { encoding: 'utf8', timeout: 5_000 })
    if (result.error !== undefined) throw result.error
    const output = `${result.stdout}\n${result.stderr}`
    if (result.status !== 0) {
      if (/not found|could not be found|no such/iu.test(output)) {
        return this.runner.exitCode === null && this.runner.signalCode === null
      }
      throw new Error(`systemctl could not read ${this.unit}: ${output.trim() || `exit ${String(result.status)}`}`)
    }
    const state = result.stdout.trim()
    if (state === 'inactive' || state === 'failed') return false
    if (state === 'active' || state === 'activating' || state === 'deactivating') return true
    throw new Error(`systemctl returned unknown ActiveState for ${this.unit}: ${JSON.stringify(state)}`)
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.stopped) return true
    this.observation ??= (async () => {
      while (this.active()) await sleepMs(15)
      this.stopped = true
    })()
    return waitWithAbort(this.observation, signal)
  }

  forcedOutcome(): { exitCode: null; signal: 'SIGKILL' } | undefined {
    return this.lastSignal === 'SIGKILL' ? { exitCode: null, signal: 'SIGKILL' } : undefined
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
  const systemdRun = internals.systemdRun ?? 'systemd-run'
  const systemctl = internals.systemctl ?? 'systemctl'
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const files = runnerFiles(spec)
  const unitBase = unitStem('dsh-subprocess')
  const child = run(systemdRun, [
    '--user',
    '--scope',
    '--quiet',
    '--wait',
    '--collect',
    '--pipe',
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
  const owner = new SystemdScopeOwner(`${unitBase}.scope`, systemctl, runSync, child)
  const result = runnerDirectResult(child, files, closed, () => owner.forcedOutcome())
  cleanupAfterRunner(files, result.direct, owner)
  return { child, pid: result.pid, direct: result.direct, closed, owner }
}
