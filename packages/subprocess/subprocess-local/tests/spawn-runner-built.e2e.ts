import { spawn } from 'node:child_process'
import type { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cleanupLinuxLaunchFiles,
  createLinuxLaunchFiles,
} from '../src/runner-protocol.ts'
import { runnerEnvironment, SUBPROCESS_RUNNER_ENV } from '../src/runner-launch.ts'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const sourceRunner = resolve(repoRoot, 'packages/subprocess/subprocess-local/src/bin.ts')
const builtRunner = resolve(repoRoot, 'packages/subprocess/subprocess-local/lib/runner.js')

function targetEnv(): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    [SUBPROCESS_RUNNER_ENV]: 'target-collision-restored',
  }
}

async function execute(invocation: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const files = createLinuxLaunchFiles({ cwd: repoRoot, env: targetEnv() })
  try {
    const child = spawn(invocation[0] as string, [
      ...invocation.slice(1),
      '--',
      process.execPath,
      '--input-type=module',
      '--eval',
      `process.stdout.write(process.argv[0]+'|'+process.cwd()+'|'+process.env.${SUBPROCESS_RUNNER_ENV})`,
    ], {
      env: runnerEnvironment(files.requestPath),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const status = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('error', rejectExit)
      child.once('exit', resolveExit)
    })
    return { status, stdout, stderr }
  } finally {
    cleanupLinuxLaunchFiles(files)
  }
}

describe('subprocess-local runner artifacts', () => {
  it('executes the source entry through the provider-owned core', async () => {
    const result = await execute([process.execPath, '--import', 'tsx/esm', sourceRunner])
    expect(result).toEqual({
      status: 0,
      stdout: `${process.execPath}|${repoRoot}|target-collision-restored`,
      stderr: '',
    })
  })

  it.skipIf(!existsSync(builtRunner))('executes the built ./runner subpath through the same core', async () => {
    const result = await execute([process.execPath, builtRunner])
    expect(result).toEqual({
      status: 0,
      stdout: `${process.execPath}|${repoRoot}|target-collision-restored`,
      stderr: '',
    })
  })
})
