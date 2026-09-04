import { defineConfig } from 'tsdown'

/**
 * The dsh application ships its CLI bin. The root tsdown builds only
 * `lib/types/index.js`, so this override points at the bin's tsc output.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
