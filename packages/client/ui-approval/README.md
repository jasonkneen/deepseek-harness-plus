# @deepseek-ai/dsh-client-ui-approval

English | [中文](README.zh.md)

Browser approval presentation over the Agent-scoped Remote Event waterfall. The plugin publishes each pending request through `ctx.uiSession`, takes over the Conversation composer, optionally renders correlated Tool detail, and returns the user's decision to the waiting Host request.

## Model Experience

None, as this package presents approval requests in the browser and registers nothing model-facing.

#### KV Cache effect

None; approval request and response rendering does not alter a model request.

## Known Limitations and Deferred Work

- **The panel exposes transient decisions only** — it supports allow-once and reject; persistent permission policy remains owned by Host-side approval packages.
