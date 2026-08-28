import { defineConfig } from 'tsdown'

/**
 * The dsh application ships its CLI bin plus the Electron child-process entry.
 * The root tsdown builds only `lib/types/index.js`, so this override points at
 * their tsc outputs instead; each reachable module bundles with its entry.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/desktop-host.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
