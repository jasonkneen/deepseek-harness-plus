/**
 * Process lifecycle for the Python SDK's closed direct-config runtime.
 *
 * @module @deepseek-ai/dsh-sdk-python-runtime/runner
 */

import { existsSync } from 'node:fs'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

/* v8 ignore start -- composition over tested app-boot/jsonrpc and executable acceptance paths */
const NAME = 'dsh-jsonrpc-agent'

/**
 * Boot the explicitly selected external configuration and own process exit.
 * @param bareModuleBaseUrl - installed-runtime base for bare plugins.
 * @returns after process handlers are installed; process lifetime then belongs
 * to stdin and signal events.
 */
export async function runPythonSdkRuntime(bareModuleBaseUrl: string): Promise<void> {
  installFailLoud(NAME)
  loadEnv(NAME)

  // Env wins over argv; empty values are absent. External config defines the deployment.
  const fromEnv = process.env['DSH_CORDIS_CONFIG']
  const fromArgv = process.argv[2]
  const requested = fromEnv !== undefined && fromEnv !== ''
    ? fromEnv
    : fromArgv !== undefined && fromArgv !== '' ? fromArgv : undefined
  const configPath = requested === undefined ? undefined : resolveConfigPath(requested, undefined)
  if (configPath === undefined || !existsSync(configPath)) {
    process.stderr.write(
      `usage: ${NAME} <path/to/cordis.yml> (or set DSH_CORDIS_CONFIG=<path>, which wins); the config is required — there is no built-in fallback\n`,
    )
    process.exit(1)
  }

  const ctx = await boot(NAME, configPath, undefined, undefined, bareModuleBaseUrl)
  let exiting = false

  async function disposeAndExit(code: number): Promise<void> {
    if (exiting) return
    exiting = true
    try {
      await ctx.fiber.dispose()
    } finally {
      process.exit(code)
    }
  }

  process.stdin.on('end', () => { void disposeAndExit(0) })
  process.on('SIGTERM', () => { void disposeAndExit(0) })
  process.on('SIGINT', () => { void disposeAndExit(130) })
}
/* v8 ignore stop */
