# @deepseek-ai/dsh-client-ui-chat

English | [中文](README.zh.md)

The browser Chat target for Conversation assembly. It registers Chat event definitions and snapshot construction, supplies `useChat`, renders transcript nodes and details, and owns Chat-specific stores, actions, localization, and scroll restoration; historical image URLs resolve through the Conversation-owned per-session cache (`ctx.uiConversation.imageUrl`). Its Assistant and Turn Tail definitions fold packed historical Assistant runs without expanding their members.

## System prompt row

Chat contributes a `System prompt` row for a non-empty initial or resumed request, an explicit series start, or an actual system-field change; same-series config-only or tool-only changes, tool steps, and retries do not duplicate it. Chat places the first header in a step at that request's message boundary — turn start for step one, step start thereafter — before the user-role messages sent with the request, matching the provider envelope's system-before-messages order; when the preceding header is outside a partial window, a non-initial header stays at its own Event and renders conservatively until prepend supplies that predecessor. The row stays collapsed by default and mounts the complete prompt in the same 141px code-block body as an opaque context injection — model-facing text with its real line breaks, not Markdown — only while expanded; it has no streaming path. Systemless headers produce no row.

## Model Experience

None, as this package renders logged conversation state in the browser and registers nothing model-facing.

#### KV Cache effect

None; Chat presentation does not assemble or mutate provider requests.

## Known Limitations and Deferred Work

- **The view reflects the loaded Session window** — older transcript nodes become available only after Session Controller loads the preceding event page.
- **Per-Turn token usage is fail-closed** — a completed Turn shows its disclosure only when the loaded window includes `turn/start` and every started model attempt has safe, exact usage. Missing buckets are omitted, and incomplete or contradictory accounting hides the whole disclosure.
