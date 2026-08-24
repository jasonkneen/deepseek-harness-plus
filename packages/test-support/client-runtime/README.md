# @deepseek-ai/dsh-client-test-runtime

English | [中文](README.zh.md)

jsdom slot test runtime for client feature specs: a real Cordis `Context`, the renderer-owned `SlotRegistry`, and the production `UiSession` adapter assembled around typed Session and Workspace Controller doubles. Feature suites exercise declaration, registration, scope, store, injection, rendering, updates, and disposal without copying production renderer or adapter logic.

The doubles implement the owner interfaces consumed through Cordis: `TestSessions implements ISessions`, `TestWorkspaces implements IWorkspaces`, each fixture Session is a `FixtureSession implements SessionFace`, and `stubSettingsScope` implements `SettingsScope`. The runtime mounts `UiSession`, which derives renderer standard sources from Controller bindings. Fixtures publish Session lifecycle state through `updateSessionSnapshot`, Workspace state through `TestWorkspaces.update`, projection values through the Session face, and Conversation input through the Session event feed. Unstubbed `ISession` behavior fails with the missing method name.

Local DOM snapshots: `declare(children)` registers an auto frame whose per-key `<div data-slot>` wrappers are snapshot roots; `renderSlot(key, owner)` returns the slot-local view (container, scoped Testing Library queries, in-place `update(owner)`); a registered snapshot serializer folds CSS-module class hashes (`_frame_a1b2c3` → `frame`) to keep `.snap` files structural and collapses `<svg>` internals to a `data-content` fingerprint. Suites needing a custom page frame use `root.declare(children, Frame)` instead; `mount(plugin)` runs a real fiber with fail-loud service prechecks, and `dispose()` tears down views, feature fibers, minted scopes, and persisted store state on one axis.

Not part of the product plugin graph (no `dsh.client`); feature packages depend on it in `devDependencies` only.

## Model Experience

None, as this package is browser-side test infrastructure; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Vitest and jsdom only.** Every consumer is an in-repository browser-oriented Vitest suite. The package is not a product plugin or a general Node test harness.
- **Session, Conversation, and Chat fixtures stay separate.** `sessionSnapshot` contains only Session Controller state, `conversationSnapshot` contains target-neutral Conversation state, and `chatSnapshot` contains Chat target state. Tests that exercise assembly provide Session event entries instead of adding Conversation or Chat fields to `SessionSnapshot`.
