#!/usr/bin/env node
/** Packaging-only entry that keeps private runner dispatch outside the public CLI. */

/* v8 ignore file -- packaged-runtime smoke exercises this physical entry. */

const selectorName = 'DSH_SUBPROCESS_RUNNER'
const selection = process.env[selectorName]

export {}

if (selection === undefined) {
  await import('./bin.ts')
} else {
  Reflect.deleteProperty(process.env, selectorName)
  const { runSelectedSubprocessRunner } = await import('@deepseek-ai/dsh-subprocess-local/runner')
  await runSelectedSubprocessRunner(selection)
}
