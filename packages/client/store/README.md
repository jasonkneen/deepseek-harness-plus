# @deepseek-ai/dsh-client-store

English | [中文](README.zh.md)

React-free observable and snapshot-store primitives shared by Client controllers and renderer adapters. The package owns synchronous and animation-frame publication, Immer-backed updates, shallow equality, and optional browser persistence; React hook construction remains in `@deepseek-ai/dsh-client-ui-renderer`.

## Model Experience

None, as this package provides browser-side state primitives and registers nothing model-facing.

#### KV Cache effect

None; the stores neither assemble nor send model requests.

## Known Limitations and Deferred Work

- **Persistence is browser-local** — persisted stores use JSON in `localStorage`; non-browser runtimes disable persistence, and the package provides no cross-device synchronization.
