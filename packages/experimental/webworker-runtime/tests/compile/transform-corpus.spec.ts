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
 * Eight Node-loader processes divide the discovered files, and the union check
 * proves that each bundle appears once. The two test-support bundles and the
 * ACL/win32-process pair stay in one ordered shard because their pinned loader
 * exemptions depend on the same preceding module state as the unsharded
 * checker.
 *
 * The corpus is the build output, so this skips on a tree that has none.
 */
import { spawn } from 'node:child_process'
import { globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const runner = fileURLToPath(new URL('./transform-corpus-check.ts', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const corpusShards = 8
const shardAffinity = new Set([
  // client-runtime needs acp-snapshot to establish Vitest's internal state.
  'packages/test-support/acp-snapshot/lib/index.js',
  'packages/test-support/client-runtime/lib/index.js',
  // win32-process observes Koffi's duplicate type names after the ACL bundle.
  'packages/sandbox/sandbox-windows-acl/lib/index.js',
  'packages/subprocess/win32-process/lib/index.js',
])

interface CorpusResult {
  readonly output: string
  readonly status: number | null
  readonly error?: string
}

/** @returns Built bundle paths in the same stable order as the checker. */
function discoverBuiltBundles(): string[] {
  return [
    ...globSync('packages/*/*/lib/index.js', { cwd: repositoryRoot }),
    ...globSync('vendor/*/lib/index.js', { cwd: repositoryRoot }),
  ].map(path => path.replaceAll('\\', '/')).sort()
}

/** @returns Non-empty shards with every bundle assigned once and loader affinity preserved. */
function partitionBundles(files: readonly string[], count: number): string[][] {
  const partitions = Array.from({ length: count }, () => [] as string[])
  files.forEach((file, index) => {
    const assigned = shardAffinity.has(file) ? 0 : index % count
    partitions[assigned]?.push(file)
  })
  return partitions.filter(partition => partition.length > 0)
}

/** @returns One isolated Node-loader corpus shard. */
function runCorpusShard(files: readonly string[]): Promise<CorpusResult> {
  return new Promise((resolveResult) => {
    let output = ''
    let spawnError: string | undefined
    const child = spawn(process.execPath, ['--import', 'tsx/esm', runner, ...files], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk })
    child.stderr.on('data', (chunk: string) => { output += chunk })
    child.once('error', (reason) => { spawnError = reason.message })
    child.once('close', (status) => {
      resolveResult({
        output,
        status,
        ...spawnError === undefined ? {} : { error: spawnError },
      })
    })
  })
}

test('partitions every bundle once while retaining loader-state affinity', () => {
  const files = [
    'packages/example/first/lib/index.js',
    ...shardAffinity,
    'packages/example/last/lib/index.js',
  ]
  const shards = partitionBundles(files, corpusShards)

  expect(shards.every(shard => shard.length > 0)).toBe(true)
  expect(shards.flat().sort()).toEqual([...files].sort())
  expect(shards[0]?.filter(file => shardAffinity.has(file))).toEqual(files.filter(file => shardAffinity.has(file)))
})

test('every built bundle transforms to the export shape Node loads', async (context) => {
  const files = discoverBuiltBundles()
  if (files.length === 0) {
    context.skip('the workspace has no build output to sweep')
    return
  }
  const shards = partitionBundles(files, Math.min(corpusShards, files.length))
  expect(shards.flat().sort()).toEqual(files)
  const finished = await Promise.all(shards.map(runCorpusShard))
  const output = finished.map((result, index) => `shard ${String(index + 1)}/${String(shards.length)}:\n${result.output}`).join('\n')
  // The runner prefixes every finding with '- ', so a failure reads as the
  // findings themselves rather than as a diff of its whole report.
  expect(output.split('\n').filter(line => line.startsWith('- ')).join('\n')).toBe('')
  for (const result of finished) {
    expect(result.error, output).toBeUndefined()
    expect(result.status, output).toBe(0)
  }
}, 900_000)
