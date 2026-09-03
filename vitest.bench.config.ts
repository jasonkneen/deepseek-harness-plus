import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

/**
 * CI performance gate. Every `*.bench.ts` file synthesizes its own input from
 * fixed parameters, measures one owner-visible path, and fails when a
 * documented time or heap budget is exceeded. Files run one at a time so a
 * measurement never shares the CPU with another benchmark.
 */
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-proxy-environment.ts'],
    include: [
      'packages/*/*/tests/**/*.bench.ts',
      'packages/*/*/tests/**/*.bench.client.ts',
    ],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 600_000,
    hookTimeout: 120_000,
    disableConsoleIntercept: true,
  },
})
