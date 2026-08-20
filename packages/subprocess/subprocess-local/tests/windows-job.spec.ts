import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { launchWindowsJob, probeWindowsJob } from '../src/windows-job.ts'

const fixture = fileURLToPath(new URL('fixtures/fake-job-runner.ts', import.meta.url))
const invocation = [process.execPath, '--import', 'tsx/esm', fixture]

function spec(argv: string[]): SubprocessSpawnSpec {
  return {
    argv,
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    graceMs: 100,
  }
}

describe('Windows Job runner adapter', () => {
  it('probes the runner before a user command is selected', () => {
    const runSync = vi.fn(() => ({ status: 0, error: undefined })) as unknown as typeof spawnSync
    expect(probeWindowsJob({ spawnSync: runSync, runnerInvocation: invocation })).toBe(true)
    expect(runSync).toHaveBeenCalledWith(
      process.execPath,
      [...invocation.slice(1), '--mode', 'probe-win32'],
      expect.objectContaining({ stdio: 'ignore' }),
    )
  })

  it('reports direct outcome separately from runner settlement', async () => {
    const launch = launchWindowsJob(spec(['fake-target', '7']), {
      spawn,
      runnerInvocation: invocation,
    })
    expect(launch.pid).toBeGreaterThan(0)
    await expect(launch.direct).resolves.toEqual({ exitCode: 7, signal: null })
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
  })

  it('signals the Job runner and waits for its managed range to stop', async () => {
    const launch = launchWindowsJob(spec(['fake-target']), {
      spawn,
      runnerInvocation: invocation,
    })
    launch.owner.signal('SIGTERM')
    await expect(launch.direct).resolves.toEqual({ exitCode: 1, signal: null })
    await expect(launch.owner.waitForExit()).resolves.toBe(true)
    launch.owner.signal('SIGKILL')
  })
})
