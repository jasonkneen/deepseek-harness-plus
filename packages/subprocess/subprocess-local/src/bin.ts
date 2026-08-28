/** Thin executable/importable entry for the provider-private runner core. */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { consumeRunnerSelection } from './runner-launch.ts'
import { reportSpawnRunnerFailure, runSpawnRunner } from './spawn-runner.ts'

/**
 * Run a selector already removed by a packaging bootstrap.
 * @param selection - private runner selector or Linux launch-request locator.
 * @param argv - private runner arguments beginning with the target delimiter.
 */
export async function runSelectedSubprocessRunner(
  selection: string,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  try {
    await runSpawnRunner(selection, argv)
  } catch (error) {
    await reportSpawnRunnerFailure(selection, error)
  }
}

function isExecutedEntry(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url
}

if (isExecutedEntry()) {
  const selection = consumeRunnerSelection()
  if (selection === undefined) {
    process.exitCode = 127
  } else {
    void runSelectedSubprocessRunner(selection)
  }
}
