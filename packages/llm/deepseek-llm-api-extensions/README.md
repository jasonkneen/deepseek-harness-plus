# @deepseek-ai/dsh-deepseek-llm-api-extensions

English | [中文](README.zh.md)

Provider-specific registry for additive top-level fields on official DeepSeek LLM API requests. `DeepSeekLlmApiExtensionRegistry` registers `ctx.deepseekLlmApiExtensions`; contributor plugins claim one declaration-merged field, and `dsh-llm-deepseek` prepares the current contributions after serializing its base request.

## Service

- `register(field, provider)` reserves one field for the calling fiber. Duplicate or malformed names fail synchronously; disposing the registration releases it for a later provider.
- `prepare(request)` snapshots the registered providers, prepares them concurrently, clones and freezes returned JSON values, and returns `{ fields, accept }`. A preparation failure rejects before HTTP dispatch; request cancellation stops awaiting providers even when one ignores its signal.
- `accept()` runs every captured post-2xx callback once. Concurrent calls join the same settlement, every callback settles before failures are reported, and several failures become one `AggregateError`.

Each provider sees the exact serialized base body, the request `AbortSignal`, plus optional `sessionId` and auxiliary-call `purpose`. It must stop its own work promptly after cancellation and returns `undefined` when its field does not apply to that request. A prepared operation retains the providers it captured even if HMR removes their registrations before HTTP acceptance.

The registry owns addition and lifecycle, not field semantics. `@deepseek-ai/dsh-session-log-deepseek` owns `dsh_session_log`; `@deepseek-ai/dsh-plugin-package-inventory-deepseek` owns `dsh_plugin_packages`. The provider-neutral LLM seam and `llm-pi-ai` do not consume this registry.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-llm-deepseek`, which sends registered fields outside the model's `messages`, system prompt, and tool schemas.

#### KV Cache effect

None; registry fields are model-hidden provider metadata and do not alter the serialized model-input prefix.

## Known Limitations and Deferred Work

- **Official DeepSeek requests only** — the registry intentionally has no provider-neutral routing or pi-ai adapter integration.
- **No field ordering contract** — JSON object member order follows registration preparation but receivers address fields by name.
