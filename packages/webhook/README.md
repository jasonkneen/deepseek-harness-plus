# webhook/ — verified external events to DSH Sessions

English | [中文](README.zh.md)

The Webhook family receives authenticated provider events, runs trusted programmatic rules, and optionally creates ordinary root Sessions inside Web Workspaces. Dispatch is process-local and fire-and-forget: the family owns no delivery database, queue, retry, deduplication, or Agent-completion state.

| Package | Role | ctx key |
|---|---|---|
| [`webhook/`](webhook/README.md) | Rule registry, callback lifecycle, and Workspace-backed Session creation | `ctx.webhookRuntime` |
| [`webhook-github/`](webhook-github/README.md) | Signed GitHub HTTP adapter | consumes `ctx.webhookRuntime` and `ctx.webServer` |

Provider adapters authenticate and normalize deliveries. Rules own arbitrary conditions and external calls, then return `null` or one Session request. The [Webhook subsystem reference](../../docs/subsystems/webhook.md) owns the shared types and timing guarantees.
