# @deepseek-ai/dsh-client-hmr

English | [中文](README.zh.md)

Hot reload for script-loaded client plugins. The web bundle mounts the row unconditionally; without a rebuild watcher (`pnpm run dev:web`) rewriting client bundles, the poll observes no changes and the chain stays idle.

The browser half subscribes to the system SSE channel (`GET /plugins/events`) and reloads one plugin per `rebuilt` frame through a serialized queue. The frame revision makes `invalidate` select that plugin's immutable one-resource combo URL instead of its initial multi-resource URL; `prefetch` loads and registers the new factory while the old fiber still serves. The remaining sequence is `registry.delete` (before the fiber: a bare fiber dispose trips the vendored Loader's self-dispose branch, which would mark the entry disabled), drain the old fiber, delete `entry.fiber`, remove owned `<style data-plugin>` tags, `entry.refresh()` re-imports and remounts, then `fiber.await()` rethrows startup failures loud. Dependents reload through cordis itself: a fiber's activation epoch strings its service providers' uids, so replacing a provider's fiber cascades every dependent with zero client-side graph analysis. The node half detects rebuilds with one interval that stat-polls each graph bundle and optional source map from the module host's pre-read baseline. An unchanged startup row begins watching without a content read or hash; a changed row, or a dirty row after its artifact reappears, enters `rebuilt()`, and only real revision changes are broadcast. Any tsdown watch process producing the artifacts therefore triggers HMR with no builder→host channel.

## Model Experience

None, as the reload driver is browser-side machinery; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Reload is coarse by design** — a fresh fiber and fresh components; React state inside the reloaded plugin is lost while the data layer (connection/runtime fibers, Session objects) is untouched. react-refresh-grade state preservation conflicts with "re-executing the bundle re-runs the factory" and is deliberately out.
- **No failure rollback** — a reload that fails leaves the entry FAILED and visible in the loader status projection; the previous bundle is not restored automatically.
- **The boot graph is not replaced by rebuilt frames** — each frame carries the plugin-artifact revision needed for its one-resource combo reload; a page reload receives the recomposed startup graph.
