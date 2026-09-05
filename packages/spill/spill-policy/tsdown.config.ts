import { defineConfig } from 'tsdown'

export default defineConfig([
  { entry: ['lib/types/index.js'], outDir: 'lib', platform: 'node', format: 'esm', clean: false, dts: false },
  {
    entry: ['lib/types/notice.js'], outDir: 'lib', platform: 'neutral', format: 'esm', clean: false, dts: false,
  },
])
