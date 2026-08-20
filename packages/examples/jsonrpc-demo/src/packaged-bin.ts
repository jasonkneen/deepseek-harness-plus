#!/usr/bin/env node
/**
 * Closed-runtime JSON-RPC agent bin. Bare plugins resolve from the installed
 * runtime closure while relative plugins remain configuration-relative.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-demo/packaged-bin
 */

import { runJsonrpcAgent } from './runner.ts'

/* v8 ignore start -- exercised through the built Python runtime carriers */
const PACKAGED_RUNNER_ARG = '--dsh-internal-subprocess-runner'

if (process.argv[2] === PACKAGED_RUNNER_ARG) {
  process.argv.splice(2, 1)
  await import('@deepseek-ai/dsh-subprocess-local/spawn-runner')
} else {
  await runJsonrpcAgent(import.meta.url)
}
/* v8 ignore stop */
