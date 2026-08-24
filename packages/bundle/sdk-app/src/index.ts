/**
 * The SDK profile's command-line and stdin-lifetime provider. A successful
 * parse publishes {@link SDK_APP_STARTUP_SERVICE}; the JSON-RPC server waits
 * for that service, so help starts no transport.
 * @module @deepseek-ai/dsh-sdk-app
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { exitOnStdinEnd, parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'sdk-app-startup'

/** Launcher service required before this app can parse its invocation. */
export const inject = ['cmdlineArgs']

/** Service the JSON-RPC server row waits for before claiming stdio. */
export const SDK_APP_STARTUP_SERVICE = 'sdkAppStartup'

/**
 * Build this app's zero-option command and help.
 * @returns a fresh program for one invocation.
 */
function sdkCommand(): Command {
  return new Command()
    .name('dsh --profile sdk')
    .description('Serve DeepSeek Harness SDK clients over stdio JSON-RPC.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Example:
  dsh --profile sdk     serve one SDK runtime until its client disconnects
`)
}

/**
 * Accept an SDK profile invocation, publish readiness, and bind EOF to the
 * launcher's bounded shutdown.
 * @param ctx - plugin context carrying command-line and exit launcher values.
 */
export function apply(ctx: Context): void {
  const program = sdkCommand()
  program.action(() => {
    exitOnStdinEnd(ctx, 'sdk-app.stdin')
    ctx.provide(SDK_APP_STARTUP_SERVICE, { accepted: true })
  })
  parseCmdline(ctx, program)
}
