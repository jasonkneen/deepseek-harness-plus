/** Run one headless task through the shipped Code Mode composition. Requires a model credential. */
import { spawn } from 'node:child_process'

const task = process.argv.slice(2).join(' ').trim()
  || 'Inspect this repository with Code Mode and report its top-level architecture.'

const child = spawn(process.execPath, [
  '--import',
  'tsx/esm',
  'apps/cli/src/bin.ts',
  '--profile',
  'headless',
  task,
], {
  stdio: 'inherit',
  env: { ...process.env, DSH_TOOLS_MODE: 'code' },
})
child.on('exit', (code, signal) => { process.exit(signal !== null ? 1 : code ?? 1) })
