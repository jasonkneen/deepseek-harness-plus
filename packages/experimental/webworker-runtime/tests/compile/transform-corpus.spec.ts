/**
 * Runs the full-corpus transform gate (`transform-corpus-check.ts`) in the
 * launcher it is written for, and reports its findings as this suite's failure.
 *
 * Spawned rather than imported, because the gate's oracle is NODE's ESM loader:
 * every built bundle's transformed export shape is compared against what
 * `await import(file)` produces there. Vitest replaces that loader with vite's
 * module runner, which imports files Node cannot — a `.css` import resolves, and
 * koffi loads a second time — so an in-process corpus run measures the transform
 * against a different loader and reports three of the four pinned baseline
 * exemptions as stale. The gate's own note applies to itself: a gate whose
 * verdict depends on how it was launched is not a gate.
 *
 * The corpus is the build output, so this skips on a tree that has none.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const runner = fileURLToPath(new URL('./transform-corpus-check.ts', import.meta.url))

test('every built bundle transforms to the export shape Node loads', (context) => {
  const finished = spawnSync(process.execPath, ['--import', 'tsx/esm', runner], { encoding: 'utf8' })
  const output = `${finished.stdout}${finished.stderr}`
  if (output.includes('no built bundles found')) {
    context.skip('the workspace has no build output to sweep')
    return
  }
  // The runner prefixes every finding with '- ', so a failure reads as the
  // findings themselves rather than as a diff of its whole report.
  expect(output.split('\n').filter(line => line.startsWith('- ')).join('\n')).toBe('')
  expect(finished.status, output).toBe(0)
}, 900_000)
