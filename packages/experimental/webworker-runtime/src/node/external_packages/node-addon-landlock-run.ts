/**
 * `@deepseek-ai/node-addon-landlock-run` stub: the Landlock launcher. Sandboxing
 * is part of the declared excluded surface, so `sandbox-local` mounts with the
 * launcher path and probe present and fails when it tries to confine a process.
 */
import { notImplementedFail } from '../notImplementedFail.ts'

const MODULE = '@deepseek-ai/node-addon-landlock-run'

/** Launcher executable name, read at module scope by sandbox-local. */
export const LAUNCHER_BIN = 'landlock-run'

/** Exit code the launcher reports when confinement itself fails. */
export const LAUNCHER_FAILURE_EXIT = 126

/**
 * Path of the launcher binary; nothing in a browser can execute it.
 * @returns The image path consumers read before failing on their own terms.
 */
export function launcherPath(): string {
  return `/dsh/bin/${LAUNCHER_BIN}`
}

/** Landlock availability probe (unavailable). */
export const probe = notImplementedFail(MODULE, 'probe')

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default { LAUNCHER_BIN, LAUNCHER_FAILURE_EXIT, launcherPath, probe }
