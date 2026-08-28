/** Select and copy the local npm tarball closure that supplies Desktop dsh. */

import { createHash } from 'node:crypto'
import {
  constants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  parseDesktopCorePackageSet,
  type DesktopCorePackageRecord,
} from '../src/core-package-set.ts'
import { capture } from '../../../scripts/release/process.ts'
import { tarballFiles } from '../../../scripts/release/tarball.ts'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const OUTPUT_ROOT = join(APP_ROOT, '.desktop-build', 'package-set')
const DEFAULT_INPUTS = [
  join(REPOSITORY_ROOT, 'dist', 'npm'),
  join(REPOSITORY_ROOT, 'dist', 'npm-vendor'),
  join(REPOSITORY_ROOT, 'dist', 'npm-landlock'),
]

const REQUIRED_DEPENDENCY_SECTIONS = ['dependencies', 'peerDependencies'] as const
const OPTIONAL_DEPENDENCY_SECTION = 'optionalDependencies'

/** Packed package information needed to form the local Desktop closure. */
export interface PackedDesktopPackage {
  readonly tarball: string
  readonly manifest: Readonly<Record<string, unknown>>
}

function dependencyNames(manifest: Readonly<Record<string, unknown>>, section: string): string[] {
  const value = manifest[section]
  if (value === undefined) return []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`desktop package set: ${String(manifest.name)} has invalid ${section}`)
  }
  return Object.keys(value).sort()
}

/**
 * Select the complete available first-party dependency closure rooted at dsh.
 * @param available - Packed packages indexed by package name.
 * @returns Selected packages sorted by name.
 */
export function selectDesktopPackageClosure(
  available: ReadonlyMap<string, PackedDesktopPackage>,
): PackedDesktopPackage[] {
  if (!available.has(DSH_PACKAGE)) throw new Error(`desktop package set: packed inputs omit ${DSH_PACKAGE}`)
  const selected = new Map<string, PackedDesktopPackage>()
  const visit = (name: string): void => {
    if (selected.has(name)) return
    const packed = available.get(name)
    if (packed === undefined) throw new Error(`desktop package set: packed inputs omit required package ${name}`)
    selected.set(name, packed)
    for (const section of REQUIRED_DEPENDENCY_SECTIONS) {
      for (const dependency of dependencyNames(packed.manifest, section)) {
        if (available.has(dependency)) visit(dependency)
        else if (dependency.startsWith('@deepseek-ai/')) {
          throw new Error(`desktop package set: ${name} requires unpacked internal package ${dependency}`)
        }
      }
    }
    for (const dependency of dependencyNames(packed.manifest, OPTIONAL_DEPENDENCY_SECTION)) {
      if (available.has(dependency)) visit(dependency)
    }
  }
  visit(DSH_PACKAGE)
  return [...selected.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, packed]) => packed)
}

function packedManifest(tarball: string): Record<string, unknown> {
  const value: unknown = JSON.parse(capture('tar', ['-xOzf', tarball, 'package/package.json']))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`desktop package set: ${tarball} has no package manifest`)
  }
  return value as Record<string, unknown>
}

function packedPackages(inputs: readonly string[]): Map<string, PackedDesktopPackage> {
  const available = new Map<string, PackedDesktopPackage>()
  for (const input of inputs) {
    const tarballs = readdirSync(input).filter(file => file.endsWith('.tgz')).sort()
    if (tarballs.length === 0) throw new Error(`desktop package set: ${input} contains no tarballs`)
    for (const file of tarballs) {
      const tarball = join(input, file)
      const manifest = packedManifest(tarball)
      const name = manifest.name
      if (typeof name !== 'string' || name === '') throw new Error(`desktop package set: ${tarball} has no package name`)
      if (available.has(name)) throw new Error(`desktop package set: duplicate packed package ${name}`)
      available.set(name, { tarball, manifest })
    }
  }
  return available
}

/** Prepare `.desktop-build/package-set` from release tarball directories. */
export function prepareDesktopPackageSet(inputs: readonly string[], output = OUTPUT_ROOT): void {
  const selected = selectDesktopPackageClosure(packedPackages(inputs))
  const dsh = selected.find(packed => packed.manifest.name === DSH_PACKAGE)
  if (dsh === undefined || !tarballFiles(dsh.tarball).includes('package/lib/desktop-host.js')) {
    throw new Error(`desktop package set: ${DSH_PACKAGE} tarball does not contain lib/desktop-host.js`)
  }
  rmSync(output, { recursive: true, force: true })
  const packageDir = join(output, DESKTOP_PACKAGES_DIR)
  mkdirSync(packageDir, { recursive: true })
  const records: DesktopCorePackageRecord[] = selected.map((packed) => {
    const name = packed.manifest.name
    const version = packed.manifest.version
    if (typeof name !== 'string' || typeof version !== 'string') {
      throw new Error(`desktop package set: ${packed.tarball} has no package identity`)
    }
    const file = basename(packed.tarball)
    const destination = join(packageDir, file)
    copyFileSync(packed.tarball, destination, constants.COPYFILE_EXCL)
    const body = readFileSync(destination)
    return {
      name,
      version,
      file,
      bytes: statSync(destination).size,
      integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
    }
  })
  const packageSet = parseDesktopCorePackageSet({ schemaVersion: 1, packages: records })
  writeFileSync(join(output, DESKTOP_PACKAGE_SET_FILE), `${JSON.stringify(packageSet, undefined, 2)}\n`, { mode: 0o600 })
}

function main(): void {
  const { values } = parseArgs({
    options: { from: { type: 'string', multiple: true }, out: { type: 'string' } },
    allowPositionals: false,
  })
  const inputs = (values.from ?? DEFAULT_INPUTS).map(path => resolve(REPOSITORY_ROOT, path))
  const output = values.out === undefined ? OUTPUT_ROOT : resolve(REPOSITORY_ROOT, values.out)
  prepareDesktopPackageSet(inputs, output)
  console.log(`desktop package set: prepared ${output}`)
}

if (import.meta.main) main()
