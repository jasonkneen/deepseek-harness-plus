/**
 * End-to-end spec of the packer's actual product: an image this package builds must
 * mount in the runtime's VFS and be `require`-able by the runtime's module loader,
 * which holds no transform of its own.
 *
 * That last part is the point. "It boots" only proves nothing crashed; the loader
 * wraps module bodies exactly as the image holds them, so the pack-time pass is the
 * only thing that can make them wrappable. The refusal case is the positive
 * evidence: restore one un-lowered body and the same setup fails loud.
 *
 * A small synthetic composition rather than the real profile: packing the full
 * closure takes tens of seconds. The path under test — compose, materialize,
 * transform, tar, compress, inflate, mount, require — is the same one.
 *
 * ONE module instance: every runtime import here goes through `src/`, because the VFS
 * and the active loader are module-level slots. The "starts with nothing loaded"
 * case asserts the instance the spec holds is the one that did the work.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createNodeBuiltins, REPLACED_PREFIXES } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtins.ts'
import { WorkerModuleLoader } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/module-system/module-loader.ts'
import { inflateImage } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/image-gzip.ts'
import { loadVfsImage } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts'
import { indexWorkspacePackages } from '../src/repository.ts'
import { DEFAULT_ROOT, MANIFEST_PATH, packVfsImage } from '../src/pack.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** A leaf workspace package: real build output, no dependencies to drag in. */
const SUBJECT = '@deepseek-ai/dsh-timeout'

const workspaces = indexWorkspacePackages(repoRoot)

/**
 * The pack consumes built `lib/` output. An unbuilt checkout (the unit
 * coverage lane runs before any build) self-skips; the built lanes and every
 * preview build exercise this same path against real artifacts.
 */
const subjectBuilt = existsSync(join(repoRoot, 'packages/util/timeout/lib/index.js'))

let memo: ReturnType<typeof packVfsImage> | undefined
const packed = (): ReturnType<typeof packVfsImage> => memo ??= packVfsImage({
  // The composition's own shape: one entry per plugin, `name:` on its own line.
  config: `- id: subject\n  name: '${SUBJECT}'\n`,
  profile: 'image-loadable-check',
  workspaces,
  resolveFrom: repoRoot,
  // Synthetic composition: nothing boots the worker assembly, so its default
  // image entries must not be demanded of this one-package closure.
  entries: [],
})

/** The image's archive, inflated once: mounting reads the tar, not the gzip member. */
let archiveMemo: Uint8Array | undefined
const archive = async (): Promise<Uint8Array> =>
  archiveMemo ??= await inflateImage(packed().image, 'the image this spec packed')

;(subjectBuilt ? describe : describe.skip)('packed image', () => {
  it('materializes the roster with every dependency resolved', () => {
    const result = packed()
    expect(workspaces.has(SUBJECT)).toBe(true)
    expect(result.roster).toEqual([SUBJECT])
    expect(result.packages.has(SUBJECT)).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('records the wrapper contract in the manifest and rewrote what it visited', () => {
    const result = packed()
    expect(Object.hasOwn(result.files, MANIFEST_PATH)).toBe(true)
    const manifest = JSON.parse(new TextDecoder().decode(result.files[MANIFEST_PATH])) as { lowered: string }
    expect(manifest.lowered).toBe(result.contract)
    expect(result.transform.rewritten).toBeGreaterThan(0)
  })

  it('names every JavaScript entry for the debugger, workspace files by repository path', () => {
    const result = packed()
    const decoder = new TextDecoder()
    const entries = Object.keys(result.files).filter(name => /\.[cm]?js$/.test(name))
    expect(entries.length).toBeGreaterThan(0)
    for (const name of entries) {
      const lines = decoder.decode(result.files[name]).split('\n')
      // V8 stacks and DevTools read the trailing comment, so worker
      // `new Function` bodies and page blobs alike show under a stable name
      // instead of as anonymous VM or blob entries.
      expect(lines.at(-1)).toMatch(/^\/\/# sourceURL=\S+$/)
      // A dangling map reference would make the debugger report one load
      // failure per named script; the packer ships no `.map` files.
      expect(lines.at(-2) ?? '').not.toContain('sourceMappingURL')
    }
    // A workspace entry is named by the path a reader navigates in this
    // repository, not by its image mount.
    const subject = decoder.decode(result.files[`node_modules/${SUBJECT}/lib/index.js`])
    expect(subject.endsWith('\n//# sourceURL=packages/util/timeout/lib/index.js')).toBe(true)
  })

  it('writes one gzip member whose header records no build facts', () => {
    const image = packed().image
    // RFC 1952 §2.3: magic, deflate, then the flag byte — no FNAME (0x08) or
    // FCOMMENT, a zero modification time, and "unknown" for the packing system.
    expect([...image.slice(0, 4)]).toEqual([0x1f, 0x8b, 0x08, 0x00])
    expect([...image.slice(4, 8)]).toEqual([0, 0, 0, 0])
    expect(image[9]).toBe(255)
  })

  it('packs the same tree to the same bytes', () => {
    // The preview build compares a freshly packed image against the shipped one,
    // so anything the compressor takes from its environment would read as a
    // changed tree.
    const again = packVfsImage({
      config: `- id: subject\n  name: '${SUBJECT}'\n`,
      profile: 'image-loadable-check',
      workspaces,
      resolveFrom: repoRoot,
      entries: [],
    })
    expect(Buffer.from(again.image).equals(Buffer.from(packed().image))).toBe(true)
  })

  it('mounts and requires through the real loader, which carries no transform', async () => {
    const vfs = loadVfsImage(await archive(), DEFAULT_ROOT)
    expect(vfs.existsSync(`${DEFAULT_ROOT}/node_modules/${SUBJECT}/lib/index.js`)).toBe(true)

    const loader = new WorkerModuleLoader({
      vfs,
      root: DEFAULT_ROOT,
      staticModules: createNodeBuiltins(),
      staticModulePrefixes: REPLACED_PREFIXES,
    })
    // The loader this spec reads counters from must be the one that did the
    // requiring; a second instance would report an empty cache trivially.
    expect(loader.usage().modules).toBe(0)

    const required = loader.requireFrom(`${DEFAULT_ROOT}/workspace`)(SUBJECT) as Record<string, unknown>
    expect(typeof required.timeoutOf).toBe('function')
    expect(loader.usage().modules).toBeGreaterThan(0)
  })

  it('refuses a body the packer did not lower, naming the image', async () => {
    // The case above only proves the packed bytes are wrappable. This is the
    // other half: the loader has no transform to fall back on, so an entry the
    // collector missed must fail loud against the image rather than boot.
    const vfs = loadVfsImage(await archive(), DEFAULT_ROOT)
    vfs.seed(
      `${DEFAULT_ROOT}/node_modules/${SUBJECT}/lib/index.js`,
      new TextEncoder().encode('export const timeoutOf = () => 0\n'),
    )
    const loader = new WorkerModuleLoader({
      vfs,
      root: DEFAULT_ROOT,
      staticModules: createNodeBuiltins(),
      staticModulePrefixes: REPLACED_PREFIXES,
    })
    expect(() => loader.requireFrom(`${DEFAULT_ROOT}/workspace`)(SUBJECT))
      .toThrow(/still carries module syntax, so the image was not lowered by the packer/)
  })
})
