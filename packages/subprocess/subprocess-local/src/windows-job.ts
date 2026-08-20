/** Windows Job runner launch and managed-range ownership. */

import { spawn, spawnSync } from 'node:child_process'
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

/** Test seams for the runner process. */
export interface WindowsJobInternals {
  spawn?: typeof spawn
  spawnSync?: typeof spawnSync
  runnerInvocation?: string[]
}

/**
 * Confirm in a separate process that shared Win32 bindings and the runner entry are available.
 * @param internals - injected process runners used by tests.
 * @returns true when native launch can be selected before a user command.
 */
export function probeWindowsJob(internals: WindowsJobInternals = {}): boolean {
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const [command, ...prefix] = invocation
  if (command === undefined) return false
  const result = (internals.spawnSync ?? spawnSync)(command, [...prefix, '--mode', 'probe-win32'], {
    env: childEnv(),
    stdio: 'ignore',
    timeout: 5_000,
  })
  return result.error === undefined && result.status === 0
}

class WindowsJobOwner implements BoundProcessOwner {
  private stopped = false
  private readonly observation: Promise<void>

  constructor(private readonly runner: ReturnType<typeof spawn>) {
    this.observation = new Promise((resolve) => {
      runner.once('close', () => {
        this.stopped = true
        resolve()
      })
    })
  }

  signal(_signal: NodeJS.Signals): void {
    if (this.stopped) return
    try {
      if (this.runner.connected) {
        this.runner.send({ type: 'terminate' }, (error) => {
          if (error !== null) this.runner.kill()
        })
      } else {
        this.runner.kill()
      }
    } catch {
      this.runner.kill()
    }
  }

  waitForExit(signal?: AbortSignal): Promise<boolean> {
    return this.stopped ? Promise.resolve(true) : waitWithAbort(this.observation, signal)
  }
}

/**
 * Launch one direct command through the Job-owning runner.
 * @param spec - exact target argv, cwd, stdio, environment, and lifecycle settings.
 * @param internals - injected process runner used by tests.
 * @returns wrapper streams, target outcome, and the bound Job owner.
 */
export function launchWindowsJob(
  spec: SubprocessSpawnSpec,
  internals: WindowsJobInternals = {},
): ManagedProcessLaunch {
  const run = internals.spawn ?? spawn
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const [command, ...prefix] = invocation
  if (command === undefined) throw new Error('subprocess-local: Windows runner invocation is empty')
  const files = runnerFiles(spec)
  const child = run(command, [
    ...prefix,
    '--mode',
    'win32',
    '--request',
    files.requestPath,
    '--events',
    files.eventsPath,
  ], {
    env: childEnv(),
    stdio: runnerStdio(spec, true),
  })
  const closed = observeChildClose(child)
  const owner = new WindowsJobOwner(child)
  const result = runnerDirectResult(child, files, closed)
  cleanupAfterRunner(files, result.direct, owner)
  return { child, pid: result.pid, direct: result.direct, closed, owner }
}
