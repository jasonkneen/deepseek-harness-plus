#!/usr/bin/env node
/**
 * Stable link target for the `dsh-pack-vfs-image` bin, forwarding to the build
 * product.
 *
 * pnpm creates a workspace package's bin link only when the link target exists
 * at install time. Pointing the bin straight at `lib/bin.js` — a build product —
 * left the link uncreated on every clean checkout, so the command was missing
 * from `node_modules/.bin` even after a build produced the file, and only an
 * install that happened to follow a build brought it back. This file is
 * committed, so the link is always created; the build product is resolved when
 * the command actually runs.
 * @module @deepseek-ai/dsh-experimental-webworker-packer/bin
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const entry = new URL('./lib/bin.js', import.meta.url)
if (!existsSync(fileURLToPath(entry))) {
  process.stderr.write('dsh-pack-vfs-image: lib/bin.js is missing — run `pnpm run build` before packing an image\n')
  process.exit(1)
}
await import(entry.href)
