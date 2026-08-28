import { defineConfig } from 'tsdown'

/**
 * The public package bin remains `bin`; `runtime-bootstrap` is selected only
 * by the Python single-file packaging pipeline.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: {
    bin: 'lib/types/bin.js',
    'runtime-bootstrap': 'lib/types/runtime-bootstrap.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
