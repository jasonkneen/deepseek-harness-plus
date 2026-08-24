/**
 * Full-corpus regression for the worker module transform: every built bundle in
 * the workspace is transformed, executed through the real wrapper contract, and
 * its export shape compared against what Node's own ESM loader produces for the
 * same file.
 *
 * This is the harness that answers "does the transform hold on real output",
 * which no hand-written case can: the corpus is whatever the build currently
 * emits, so a rolldown upgrade that starts emitting an unseen module form shows
 * up here first.
 *
 * Module-syntax statistics are counted from the acorn AST, so the check has no
 * separate lexer dependency. Baseline exemptions are a pinned list, not a count:
 * four files cannot be imported by Node in this repository for reasons unrelated
 * to the transform, and an unexpected member fails the run.
 *
 * Cost: this walks the whole build output and imports every bundle, so it takes
 * tens of seconds and needs `pnpm run build:lib:host` to have run. It is a
 * heavyweight suite, not part of a default aggregator run.
 *
 * Run: tsx tests/compile/transform-corpus-check.ts [files...]
 * With no arguments it discovers the corpus itself.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'acorn'
import { createAlsRuntime } from '../../src/polyfill/async-context/als-runtime.ts'
import { lowerModuleSource } from '../../src/compile/transform.ts'
import { WRAPPER_PARAMS } from '../../src/image-layout.ts'

const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url))

/**
 * Files Node's ESM loader cannot import in this repository, so no baseline
 * export shape exists to compare against. None is a transform failure: each is
 * checked to still TRANSFORM cleanly, only the comparison is skipped.
 *
 * Named rather than counted: an unlisted baseline failure is a real finding
 * (a bundle that stopped being importable), and it must not hide inside a total.
 * A listed file that becomes importable also fails, so the list cannot rot.
 */
const BASELINE_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['packages/client/ui-primitives/lib/index.js', 'imports .css, which bare Node cannot load'],
  ['packages/client/web/lib/index.js', 'imports .css, which bare Node cannot load'],
  ['packages/subprocess/win32-process/lib/index.js', 'koffi type-name collision on a second load'],
  ['packages/test-support/client-runtime/lib/index.js', "needs vitest's internal state"],
])

/**
 * Bundles whose own SOURCE contains the double-lowering sentinels, so the
 * transform's guard refuses them by design.
 *
 * This package is the only such case and the refusal is correct: its bundle
 * carries `transform.ts`'s own template literals (`` `__als$${n}` `` from
 * `alsTemp`, and the `${ALS}.pause(` fragments), which is exactly the text the
 * guard looks for. A self-referential false positive is the right trade: the
 * guard exists because a mis-wired image manifest would otherwise show up only
 * as "slower", and no roster row transforms this package.
 *
 * Listed rather than skipped silently, and asserted to keep refusing: if the
 * guard stopped tripping here, either the guard or this bundle's contents
 * changed, and both are worth knowing about.
 */
const DOUBLE_LOWERING_SENTINEL: ReadonlySet<string> = new Set([
  'packages/experimental/webworker-runtime/lib/index.js',
])

let failures = 0
const report: string[] = []
const log = (line: string): void => {
  report.push(line)
  process.stdout.write(`${line}\n`)
}
const fail = (line: string): void => {
  failures += 1
  log(line)
}

/** @returns Built bundles under a two-level package directory, in stable order. */
function discover(): string[] {
  const found: string[] = []
  /** @returns Sorted subdirectory names, or none when the path is not a readable directory. */
  const subdirectories = (path: string): string[] => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
    } catch {
      return []
    }
  }
  for (const group of ['packages', 'vendor']) {
    const groupDirectory = join(repositoryRoot, group)
    for (const entry of subdirectories(groupDirectory)) {
      // `packages/<group>/<package>/lib/index.js`, `vendor/<package>/lib/index.js`.
      const candidates = group === 'vendor'
        ? [join(groupDirectory, entry, 'lib', 'index.js')]
        : subdirectories(join(groupDirectory, entry))
          .map(child => join(groupDirectory, entry, child, 'lib', 'index.js'))
      for (const candidate of candidates) {
        try {
          if (statSync(candidate).isFile()) found.push(candidate)
        } catch {
          // No bundle for this package: it may not build a runtime artifact.
        }
      }
    }
  }
  return found
}

/**
 * @returns Path relative to the repository root, for stable diagnostics.
 * Always POSIX-separated: the exemption table and the recorded findings key
 * on one form, and a win32 walk would otherwise miss every entry.
 */
const relative = (path: string): string => path.slice(repositoryRoot.length).replaceAll('\\', '/')

/**
 * Present a Node ESM namespace the way the worker loader hands one over, so a
 * real dependency and a transformed one look the same to the module body.
 * @param value - A module namespace, or whatever `require` returned.
 * @returns The value, or an `__esModule`-marked projection of a Module namespace.
 */
function asLoaderExports(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if ((value as { [Symbol.toStringTag]?: string })[Symbol.toStringTag] !== 'Module') return value
  const out: Record<string, unknown> = {}
  Object.defineProperty(out, '__esModule', { value: true })
  for (const key of Object.keys(value)) {
    Object.defineProperty(out, key, { enumerable: true, get: () => (value as Record<string, unknown>)[key] })
  }
  return out
}

/**
 * Specifiers a transformed body will request, read straight out of the emitted
 * code. The transform emits every static import as `require(<string literal>)`
 * (`transform.ts` builds them with `JSON.stringify`), so a literal scan finds
 * exactly the set that must be resolvable before the body runs. A dynamic
 * `import(expr)` is not found and does not need to be: it resolves lazily,
 * after the body has already produced its exports.
 * @param code - Emitted CommonJS body.
 * @returns The requested specifiers, deduplicated.
 */
function requestedSpecifiers(code: string): string[] {
  const found = new Set<string>()
  for (const match of code.matchAll(/require\("((?:[^"\\]|\\.)*)"\)/g)) {
    const raw = match[1]
    if (raw !== undefined) found.add(JSON.parse(`"${raw}"`) as string)
  }
  return [...found]
}

/**
 * Load a dependency through the same loader that produces this check's baseline.
 *
 * This matters more than it looks. The baseline every file is compared against is
 * `await import(file)` — Node's ESM loader. A dependency fetched with
 * `createRequire` instead goes through the CommonJS resolver, which selects the
 * `require` condition of a package's `exports` map: for a dual-build package that
 * is a DIFFERENT ARTIFACT with a different interop shape. `@deepseek-ai/schemastery`
 * is the case that exposed it — `require` yields `lib/index.cjs`, whose
 * `module.exports` is the `Schema` function with no `default` and no `__esModule`,
 * while `import` yields `lib/index.mjs`, a namespace with `default`. A body
 * written against the second shape misbehaves when handed the first.
 *
 * That divergence also made the whole check runner-dependent: under the `tsx` CLI
 * `require` was patched to return the ESM view and all 228 passed, while under
 * `node --import tsx/esm` three files failed. A gate whose verdict depends on how
 * it was launched is not a gate, so dependencies now come from `import()` and the
 * CommonJS path is only a fallback.
 * @param specifier - Module specifier as the transformed body requests it.
 * @param path - Absolute path of the importing bundle.
 * @returns The dependency in loader-facing form, or undefined when neither loader can supply it.
 */
async function loadDependency(specifier: string, path: string): Promise<unknown> {
  const real = createRequire(pathToFileURL(path))
  try {
    // Resolve through the importer so relative and bare specifiers both work, then
    // import the resolved file: resolution is CommonJS's, delivery is ESM's.
    const resolved = specifier.startsWith('node:') ? specifier : pathToFileURL(real.resolve(specifier)).href
    return asLoaderExports(await import(resolved))
  } catch {
    // Not importable as ESM (a genuine CommonJS-only dependency, or unresolvable).
    try {
      return asLoaderExports(real(specifier))
    } catch {
      return undefined
    }
  }
}

/** A stand-in for a dependency Node cannot load here: every access answers something callable. */
function fakeModule(): unknown {
  const target: Record<string, unknown> = {}
  return new Proxy(target, {
    get: (holder, key) => {
      if (key === '__esModule') return true
      if (key === 'default') return function fakeDefault() {}
      if (typeof key === 'symbol') return undefined
      if (!(key in holder)) holder[key] = function fakeNamed() {}
      return holder[key]
    },
    has: () => true,
  })
}

const als = createAlsRuntime()

/**
 * Execute a transformed body under the real wrapper contract.
 *
 * Dependencies are loaded BEFORE the body runs, because the body's `require` is
 * synchronous while faithful delivery ({@link loadDependency}) is not. A
 * dependency neither loader can supply falls back to a permissive stand-in: the
 * subject under test is this file's own export shape, not its dependencies'.
 * @param code - Emitted CommonJS body.
 * @param path - Absolute path of the bundle, used for resolution and diagnostics.
 * @returns The populated `exports` object.
 */
async function runTransformed(code: string, path: string): Promise<Record<string, unknown>> {
  const exports: Record<string, unknown> = {}
  const module = { exports }
  const loaded = new Map<string, unknown>()
  await Promise.all(requestedSpecifiers(code).map(async (specifier) => {
    const delivered = await loadDependency(specifier, path)
    if (delivered !== undefined) loaded.set(specifier, delivered)
  }))
  const fakes = new Map<string, unknown>()
  const require = (specifier: string): unknown => {
    const delivered = loaded.get(specifier)
    if (delivered !== undefined) return delivered
    if (!fakes.has(specifier)) fakes.set(specifier, fakeModule())
    return fakes.get(specifier)
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the wrapper contract under test is a `new Function` body
  const factory = new Function(...WRAPPER_PARAMS, code) as (...args: unknown[]) => void
  const metaRequire = createRequire(pathToFileURL(path))
  factory(exports, require, module, path, path.replace(/\/[^/]*$/, ''), {
    url: pathToFileURL(path).href,
    // Path-anchored like the worker loader; an import-only export face falls
    // back to this check file's own resolver.
    resolve: (specifier: string) => {
      try {
        return pathToFileURL(metaRequire.resolve(specifier)).href
      } catch {
        return import.meta.resolve(specifier)
      }
    },
  }, als)
  return exports
}

/** Module-syntax counts read from the AST. */
interface Counts {
  staticImports: number
  dynamicImports: number
  importMeta: number
  awaitExpressions: number
}

/** @returns Occurrence counts of the forms the transform rewrites. */
function countForms(source: string, _path: string): Counts {
  const counts: Counts = { staticImports: 0, dynamicImports: 0, importMeta: 0, awaitExpressions: 0 }
  let program: unknown
  try {
    program = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true })
  } catch {
    // Counting is reporting only; a parse failure is the transform's to report.
    return counts
  }
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    const record = node as Record<string, unknown>
    if (typeof record.type !== 'string') return
    if (record.type === 'ImportDeclaration') counts.staticImports += 1
    if (record.type === 'ImportExpression') counts.dynamicImports += 1
    if (record.type === 'AwaitExpression') counts.awaitExpressions += 1
    if (record.type === 'MetaProperty' && (record.meta as { name?: string } | undefined)?.name === 'import') {
      counts.importMeta += 1
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      walk(value)
    }
  }
  walk(program)
  return counts
}

const files = process.argv.slice(2).length > 0
  ? process.argv.slice(2).map(path => (path.startsWith('/') ? path : join(process.cwd(), path)))
  : discover()

if (files.length === 0) {
  process.stdout.write('transform-corpus-check: no built bundles found; run `pnpm run build:lib:host` first\n')
  process.exitCode = 1
} else {
  const verdicts = {
    ok: 0, mismatch: 0, transformFailed: 0, execFailed: 0, exempt: 0, unexpectedBaseline: 0, sentinelRefused: 0,
  }
  const totals = { bytesIn: 0, bytesOut: 0, lowered: 0, unchanged: 0, lineDrift: 0 }
  const counts: Counts = { staticImports: 0, dynamicImports: 0, importMeta: 0, awaitExpressions: 0 }

  for (const file of files) {
    const key = relative(file)
    const source = readFileSync(file, 'utf8')
    const observed = countForms(source, file)
    counts.staticImports += observed.staticImports
    counts.dynamicImports += observed.dynamicImports
    counts.importMeta += observed.importMeta
    counts.awaitExpressions += observed.awaitExpressions
    totals.bytesIn += source.length

    let code: string
    try {
      code = lowerModuleSource({ filename: file, source }).code
    } catch (reason) {
      const message = (reason as Error).message
      if (DOUBLE_LOWERING_SENTINEL.has(key)) {
        // Expected: this bundle's own text contains the sentinels the guard
        // matches. Assert it is really the guard talking, not some other refusal.
        if (message.includes('already lowered')) {
          verdicts.sentinelRefused += 1
        } else {
          fail(`- WRONG REFUSAL ${key}: expected the double-lowering guard, got: ${message}`)
        }
        continue
      }
      fail(`- TRANSFORM FAILED ${key}: ${message}`)
      verdicts.transformFailed += 1
      continue
    }
    if (DOUBLE_LOWERING_SENTINEL.has(key)) {
      fail(`- STALE SENTINEL ${key}: the double-lowering guard no longer refuses it; `
        + 'remove it from DOUBLE_LOWERING_SENTINEL or check whether the guard still works')
    }
    totals.bytesOut += code.length
    if (code === source) totals.unchanged += 1
    else totals.lowered += 1

    // The debugging contract, over the whole corpus: a transformed body has the
    // same line count as its source, so a stack frame still points at the right
    // line.
    const sourceLines = source.split('\n').length
    const codeLines = code.split('\n').length
    if (sourceLines !== codeLines) {
      fail(`- LINE DRIFT ${key}: source ${String(sourceLines)} lines, transformed ${String(codeLines)}`)
      totals.lineDrift += 1
    }

    const exemption = BASELINE_EXEMPT.get(key)
    let expected: string[]
    try {
      expected = Object.keys(await import(pathToFileURL(file).href) as object).sort()
    } catch (reason) {
      if (exemption === undefined) {
        // A bundle that stopped being importable is a real finding, so it fails
        // rather than joining a tolerated total.
        fail(`- UNEXPECTED BASELINE FAILURE ${key}: ${(reason as Error).message.split('\n')[0]}`)
        verdicts.unexpectedBaseline += 1
      } else {
        verdicts.exempt += 1
      }
      continue
    }
    if (exemption !== undefined) {
      // The exemption list must stay honest in the other direction too: a file
      // that became importable should leave the list.
      fail(`- STALE EXEMPTION ${key}: imports fine now (${exemption}); remove it from BASELINE_EXEMPT`)
    }

    let actual: string[]
    try {
      actual = Object.keys(await runTransformed(code, file)).sort()
    } catch (reason) {
      fail(`- EXEC FAILED ${key}: ${(reason as Error).message.split('\n')[0]}`)
      verdicts.execFailed += 1
      continue
    }

    const missing = expected.filter(name => !actual.includes(name))
    const extra = actual.filter(name => !expected.includes(name))
    if (missing.length === 0 && extra.length === 0) {
      verdicts.ok += 1
      continue
    }
    fail(`- EXPORT MISMATCH ${key}: missing=[${missing.join(',')}] extra=[${extra.join(',')}]`)
    verdicts.mismatch += 1
  }

  const growth = totals.bytesIn === 0 ? 0 : ((totals.bytesOut - totals.bytesIn) / totals.bytesIn) * 100
  log('')
  log(`files=${String(files.length)} ok=${String(verdicts.ok)} exportMismatch=${String(verdicts.mismatch)} `
    + `transformFailed=${String(verdicts.transformFailed)} execFailed=${String(verdicts.execFailed)} `
    + `lineDrift=${String(totals.lineDrift)} baselineExempt=${String(verdicts.exempt)} `
    + `sentinelRefused=${String(verdicts.sentinelRefused)} `
    + `unexpectedBaselineFailure=${String(verdicts.unexpectedBaseline)}`)
  log(`lowered=${String(totals.lowered)} packedAsIs=${String(totals.unchanged)} `
    + `bytes ${String(totals.bytesIn)} -> ${String(totals.bytesOut)} (${growth.toFixed(1)}%)`)
  log(`forms: staticImport=${String(counts.staticImports)} dynamicImport=${String(counts.dynamicImports)} `
    + `importMeta=${String(counts.importMeta)} await=${String(counts.awaitExpressions)}`)

  process.stdout.write(failures === 0
    ? `\ntransform-corpus-check: ${String(verdicts.ok)} bundles match their ESM baseline, `
      + `${String(verdicts.exempt)} exempt, ${String(verdicts.sentinelRefused)} sentinel-refused, no drift\n`
    : `\ntransform-corpus-check: ${String(failures)} finding(s)\n`)
  process.exitCode = failures === 0 ? 0 : 1
}
