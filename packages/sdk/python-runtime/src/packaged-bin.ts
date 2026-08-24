#!/usr/bin/env node
/**
 * Closed-runtime JSON-RPC agent bin. Bare plugins resolve from the installed
 * runtime closure while relative plugins remain configuration-relative.
 *
 * @module @deepseek-ai/dsh-sdk-python-runtime/packaged-bin
 */

import { runPythonSdkRuntime } from './runner.ts'

/* v8 ignore next -- exercised through the built Python runtime carriers */
await runPythonSdkRuntime(import.meta.url)
