# @deepseek-ai/dsh-acp

English | [中文](README.zh.md)

Automation-only [Agent Client Protocol](https://agentclientprotocol.com) v1 server over JSON-RPC stdio. Trusted programmatic clients can discover standard configuration, create or resume persistent harness Agents, attach MCP servers, prompt and cancel work, receive semantic execution updates, and close one session without affecting others.

This package is not a UI integration. It emits standard ACP semantic data, never DSH presentation cards, terminal views, diffs, locations, plans, titles, todos, custom methods, custom capability flags, or DSH-specific `_meta`. Client `_meta` is accepted as protocol metadata and has no private DSH meaning.

## Plugin

`apply(ctx, config)` opens an ACP SDK agent app on stdin/stdout and drives `ctx.agents`. Stdout is reserved for protocol frames. Complete lifecycle support requires `ctx.sessionPersistence`.

| Config | Default | Meaning |
|---|---|---|
| `provider` | — | Initial provider route for each created or resumed Agent. |
| `model` | — | Initial exact model for each created or resumed Agent. |
| `sessionListPageSize` | `100` | Positive maximum number of summaries in one `session/list` page. |

`provider` and `model` may be omitted when another Agent request listener supplies the initial route. The runnable ACP composition requires both.

## Standard ACP v1 surface

| Method or notification | Behavior |
|---|---|
| `initialize` | Negotiates stable ACP v1. Advertises standard `session/list`, `session/resume`, `session/close`, and Streamable HTTP MCP support. Image prompts are advertised only when a durable attachment store and the configured exact route support them. |
| `authenticate` | No-op because the server advertises no authentication methods. |
| `session/new` | Creates one Agent with an absolute primary `cwd`, validates and mounts standard stdio or HTTP MCP servers before publishing the Agent, explicitly materializes its durable header, and returns the complete configuration-option state. |
| `session/list` | Returns deterministic newest-first pages of persisted, resumable top-level sessions. Summaries contain only `sessionId` and absolute `cwd`; cursors are opaque keyset tokens. An optional absolute `cwd` filter uses physical-directory identity when paths exist. Active sessions and subagent/fork descendants are omitted. |
| `session/resume` | Rejects an active id, verifies the persisted canonical workspace before Agent composition, restores the log without replaying it to the client, mounts the request's MCP servers, and returns the complete configuration-option state. |
| `session/close` | Cancels active work, drains ordered updates and continuable descendants, flushes persistence, and disposes only that Agent scope. Persisted state remains available to `session/list` and `session/resume`. |
| `session/set_config_option` | Sets an advertised `model` or `reasoning_effort` value and returns the complete resulting state. Invalid ids and values reject as invalid params. |
| `session/prompt` | Admits ordered text, resource links, and supported images; permits one in-flight prompt per session; and settles only after Agent idle plus ordered update delivery. |
| `session/cancel` | Cancels the addressed prompt admission or turn through its prompt-owned cancellation path. With no ACP prompt in flight it cancels autonomous work; unknown ids are no-ops. |
| `$/cancel_request` | Cancellation of a `session/prompt` JSON-RPC request uses the same prompt-owned path as `session/cancel`. |
| `session/update` | Emits committed message, thought, generic tool lifecycle, configuration, and context-usage updates described below. |
| `session/request_permission` | Requests one standard one-shot allow or reject decision after the referenced `tool_call` notification has been delivered. |

Unsupported surfaces are omitted from capabilities or reject when addressed: `session/load`, `session/delete`, `session/fork`, additional directories, SSE and ACP-transport MCP, modes, commands, plans, terminals, client filesystem operations, and elicitation.

## Session configuration

Every new or resumed session returns standard select options:

- `model` groups choices by provider from the advisory LLM catalog. Values are opaque strings carrying the exact provider/model pair; clients must return them unchanged.
- `reasoning_effort` is derived from the selected exact model and is omitted when that model does not declare reasoning choices. When the adapter exposes choices but preserves the provider's own default, a `Provider default` choice represents omitting an explicit effort.

The ACP plugin's `provider` and `model` config establish the initial selection. Adapter topology changes emit `config_option_update` with the complete current state. Mutations are serialized per session.

An accepted prompt snapshots the selected route before asynchronous image admission. Its per-session module associates that snapshot with the identified inbox message until claim, then pins the same provider, model, and reasoning effort across image validation, prompt variables, and every model step in that turn. A concurrent option change applies to the next ACP turn.

## MCP trust and isolation

ACP clients are trusted automation controllers. A stdio declaration authorizes DSH to execute its absolute command in the session `cwd` with the supplied arguments and environment entries. An HTTP declaration authorizes requests to its absolute HTTP(S) URL with the supplied headers. DSH does not reinterpret client metadata or add private cwd, timeout, or transport fields.

Server names are validated and converted to stable DSH MCP namespaces; duplicate normalized names reject before Agent publication. Environment names/values and HTTP headers are validated, including case-insensitive duplicate headers. Standard stdio and Streamable HTTP clients use `dsh-mcp-client`'s existing tool-call timeout and reconnect defaults. Initial connection and tool discovery must succeed, so any failure rolls back the unpublished Agent.

Each Agent scope owns its MCP registrations and connections. The same server namespace may therefore exist in independent ACP sessions, while a duplicate inside one session still fails. Session close, connection loss, and plugin disposal release the scoped tools and transports.

## Semantic updates

Per-session delivery is serialized and drained before prompt completion:

| Durable DSH fact | Standard ACP update |
|---|---|
| Committed assistant text or image | `agent_message_chunk` with the durable message id |
| Committed reasoning | `agent_thought_chunk` with the durable message id |
| Durable tool call | `tool_call` with the DSH call id, canonical DSH tool name as `title`, generic `other` kind, and parsed input when valid JSON |
| Durable tool result | `tool_call_update` with the same call id, completed/failed status, and standard content blocks |
| Known context capacity plus measured context pressure | `usage_update` |
| LLM adapter topology change | `config_option_update` with all options |

Raw model deltas, retry attempts, presentation data, and unsupported core content never enter the ACP wire. Committed images are re-read and integrity-verified before inline base64 delivery. A missing or corrupt committed image fails the correlated prompt instead of producing a placeholder.

## Lifecycle and outcomes

One connection may own several independent sessions. Exact Agent identity guards event and permission routing. Each per-session module owns its Agent handle, MCP mounts, future and turn-pinned model selections, prompt slot, update chain, and memoized close operation.

Explicit close, connection loss, and plugin disposal use the same quiescent teardown. Teardown stops new work, cancels prompt admission and Agent activity, drains committed updates, disposes continuable descendants child-first, flushes the session, and releases every Agent scope. Failures are reported only after all owned teardown work settles; other frontends sharing the Context are untouched.

Prompt settlement precedence is explicit cancellation, committed-output failure, interval-wide Agent failure, then the correlated turn ending. Standard outcomes include `end_turn`, `max_tokens`, and `cancelled`; correlated model failures become standard JSON-RPC errors. No additional DSH result object is returned.

## Running

`pnpm --dir /path/to/deepseek-harness run demo:acp` boots the repository's automation server composition. The generic keyless conformance test drives this bin using only the ACP SDK, including model selection, MCP attachment, close, process restart, list/resume, and cancellation.

## Model Experience

### Prompt content

#### What the model sees

`session/prompt` produces an ordinary logged user message. Text/image order is preserved; adjacent text is concatenated; a resource link becomes a bracketed `[resource_link name=… uri=…]` reference. Inline image base64 is discarded after durable admission. Protocol metadata, client capabilities, permission choices, session ids, and ACP configuration objects do not enter model requests.

#### Token effect

Prompt content, tool calls/results, and durable image references remain in that session until compaction. Concurrent sessions retain independent contexts.

#### KV Cache effect

Append-only while the selected route and assembled prefix stay unchanged. A model change starts the next ACP turn on the new route.

## Known Limitations and Deferred Work

- Only one primary workspace is supported. Additional directories remain unsupported.
- Only PNG, JPEG, WebP, and GIF prompt images are supported, subject to the attachment store and exact model route.
- MCP resources and prompts have no DSH consumer; ACP mounts expose MCP tools only.
- Session deletion, fork, transcript replay through `session/load`, modes, commands, plans, terminals, client filesystem operations, and elicitation remain outside this automation surface.
