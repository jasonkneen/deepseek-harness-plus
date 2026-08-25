# @deepseek-ai/dsh-client-ui-session

English | [中文](README.zh.md)

React and Slot adapter for Session Controller state. It contributes Session list and pending-interaction hooks at root scope, materializes per-Session hooks and props, and owns the standard `SessionProvider` rendering behavior without taking ownership of Session transport or lifecycle state.

## Model Experience

None, as this package adapts browser-side Session state and registers nothing model-facing.

#### KV Cache effect

None; Session selectors and Slot scopes do not assemble model requests.

## Known Limitations and Deferred Work

- **Pending interactions are process-local projections** — the owning Remote waterfall must replay an outstanding request after a browser reconnect.
