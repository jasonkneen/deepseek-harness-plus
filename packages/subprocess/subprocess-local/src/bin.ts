/** Thin process entry for the ordinary subprocess native runner. */

import { reportSpawnRunnerFailure, runSpawnRunner } from './spawn-runner.ts'

const argv = process.argv.slice(2)
try {
  await runSpawnRunner(argv)
} catch (error: unknown) {
  reportSpawnRunnerFailure(argv, error)
  process.exitCode = 127
}
