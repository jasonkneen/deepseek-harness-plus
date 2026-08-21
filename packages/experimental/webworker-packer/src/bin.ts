#!/usr/bin/env node
/**
 * Pack a VFS image from this repository: compose the profile, materialize the
 * closure, lower every module body, write the gzip-compressed tar.
 *
 * Usage: dsh-pack-vfs-image --out <file> [--profile web] [--root /dsh]
 *        node --import tsx/esm src/bin.ts --out ../../apps/web/dist/preview/vfs-image.tar.gz
 * @module @deepseek-ai/dsh-experimental-webworker-packer/src/bin
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packVfsImage } from './pack.ts'
import { composeProfile, configTrees, describePack, indexWorkspacePackages } from './repository.ts'

/**
 * Read one `--flag value` pair.
 * @param name - Flag name without dashes.
 * @param fallback - Value when the flag is absent.
 * @returns The value.
 * @throws When the flag is present with no value, because silently packing the
 * default profile is worse than stopping.
 */
function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) {
    if (fallback !== undefined) return fallback
    throw new Error(`dsh-pack-vfs-image: --${name} is required`)
  }
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`dsh-pack-vfs-image: --${name} needs a value`)
  }
  return value
}

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const profile = flag('profile', 'web')
const out = flag('out')
const outputFile = isAbsolute(out) ? out : resolve(process.cwd(), out)

const result = packVfsImage({
  config: composeProfile(repoRoot, profile),
  profile,
  root: flag('root', '/dsh'),
  workspaces: indexWorkspacePackages(repoRoot),
  resolveFrom: repoRoot,
  configTrees: configTrees(repoRoot),
})

if (result.missing.length > 0) {
  throw new Error(`vfs image: ${String(result.missing.length)} dependencies did not resolve; the image would be incomplete`)
}

mkdirSync(dirname(outputFile), { recursive: true })
writeFileSync(outputFile, result.image)
process.stdout.write(describePack(result, repoRoot, outputFile).join('\n'))
