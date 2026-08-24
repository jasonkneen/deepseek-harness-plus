/**
 * `chokidar` stub: a constructible watcher that never fires. Settings and
 * credentials call `watch()` unconditionally in `[Service.init]`, and the
 * in-memory VFS has no external writer, so "no events" is the truth here rather
 * than a degradation.
 */

/** No-op watcher with chokidar's chainable face. */
export class FSWatcher {
  /**
   * Register a listener; no event is ever emitted.
   * @returns this watcher.
   */
  on(): this {
    return this
  }

  /**
   * Register a one-shot listener; no event is ever emitted.
   * @returns this watcher.
   */
  once(): this {
    return this
  }

  /**
   * Add paths to the (inert) watch set.
   * @returns this watcher.
   */
  add(): this {
    return this
  }

  /**
   * Remove paths from the (inert) watch set.
   * @returns this watcher.
   */
  unwatch(): this {
    return this
  }

  /**
   * Watched paths, as chokidar reports them.
   * @returns An empty record; nothing is ever watched.
   */
  getWatched(): Record<string, string[]> {
    return {}
  }

  /** Close the watcher. */
  async close(): Promise<void> {
    // Nothing was ever watched.
  }
}

/**
 * Create an inert watcher.
 * @returns the watcher.
 */
export function watch(): FSWatcher {
  return new FSWatcher()
}

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default { watch, FSWatcher }
