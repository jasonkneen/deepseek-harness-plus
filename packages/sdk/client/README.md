# @deepseek-ai/dsh-sdk-client

English | [中文](README.zh.md)

The TypeScript client SDK for driving the same-version [`dsh`](../../../apps/cli/README.md) runtime over stdio JSON-RPC. `DeepSeekHarness` is the high-level owned-run API; `HarnessClient` is the lower-level protocol client. The package depends on `@deepseek-ai/dsh` and resolves that installed CLI directly, so ordinary consumers do not discover a runtime executable or maintain a second application configuration. A clean source checkout whose `lib/bin.js` does not exist launches the same package's `src/bin.ts` through its resolved `tsx/esm` loader and an internal patch that omits build-generated Typert contribution loading; the SDK JSON-RPC application does not consume that remote gateway. An installed package uses the complete built entry.

Both client layers accept the same launch fields: `dshBin?`, `profile?` (default `sdk`), ordered `patches?`, `dshHome?`, `processCwd?`, `env?`, and request/initialize/shutdown/disposal timeouts. Caller-relative CLI-module, patch, explicit home, and process-cwd paths become absolute before spawn. The client runs the dsh CLI module through its current Node executable on every platform. An omitted home keeps normal dsh resolution (`DSH_HOME`, then `~/.dsh`); an explicit home overrides the child environment. `env` replaces the child environment when supplied; the client reads either that object or `process.env` when `start()` actually spawns, so mutations before the first start are visible.

Composition customization stays in the profile system. Install persistent bundles and plugin dependencies with `dsh plugin --profile <name> …`, edit that profile's `cordis.patch.yml`, and select it with `profile`. Use `patches` for ordered per-launch overrides. A patch replaces a row's complete config, and a custom profile must retain `@deepseek-ai/dsh-sdk-app` or another SDK server row.

## DeepSeekHarness

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

await using harness = new DeepSeekHarness({
  profile: 'sdk',
  patches: ['./automation.cordis.yml'],
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: ReasoningEffortId('max'),
  maxTokens: 49_152,
})
const result = await harness.run('say hi')
console.log(result.finalResponse)
```

The dsh process starts lazily on first use and stays owned across `run()` calls. `close()` (or `await using`) is required. `start()` memoizes the bounded `initialize` handshake, which carries the workspace cwd, provider/model route, optional adapter-owned `reasoningEffort`, and optional positive `maxTokens` output cap. `initializeTimeoutMs` defaults to 10 seconds, and its diagnostic names the selected profile with the retained stderr tail. The server validates the exact route before accepting prompts; omitting the effort preserves the model's own default. When a failed handshake is cleaned up successfully, the instance installs a fresh client so a later call retries with a new process until terminal `close()`. If initialization and SDK-owned cleanup both fail, `start()` rejects with an `AggregateError` whose ordered errors preserve both causes and retains the failed client rather than spawning beside a process whose exit was not proved. The cap applies to each root-agent request and is inherited by in-process descendants; compaction plugins own their separate summary limits. `session(id?)` opens a named or fresh session handle.

The handshake carries the absolute session workspace plus provider/model, optional `reasoningEffort`, and optional positive `maxTokens`. `run(input, { sessionId?, onNotification? })` accepts text or `SdkPromptContentBlock[]`; inline raster blocks carry canonical base64 plus `mimeType` and become durable attachments inside the runtime. The call queues the prompt, waits for its durable inbox receipt, and collects until the whole root agent next becomes idle. It returns `RunResult { sessionId, finalResponse, events, notifications }`; `events` is root-scoped, while notifications also contain discovered descendants.

## HarnessClient

The low-level client exposes `start()`/`initialize()`/`prompt()`/`request()`/`close()` and notification subscriptions. `prompt()` returns the durable message id after enqueue, not a prompt result. `subscribeSessionTree(id)` scopes the process-wide notification stream to one session lineage. Exported failures are `JsonRpcResponseError`, `RequestTimeoutError`, `SdkProtocolError`, and `TransportClosedError`.

`close()` requests protocol `shutdown` (default bound 1000 ms), then uses stdin EOF → SIGTERM → SIGKILL (`disposeEofGraceMs` 6000, `disposeGraceMs` 3000) until the process exits. This client lives outside any Harness context, so its private process adapter is the documented SDK-managed transport exception to `dsh-subprocess`; generic command/argv launching is package-test machinery, not a consumer interface.

## Model Experience

None, as this library adds no model-visible content; the selected dsh profile owns the spawned model's prompt, tools, policy, and cache prefix (see [`dsh-sdk-app`](../../bundle/sdk-app/README.md)).

#### KV Cache effect

None in the client process. Profile, patch, provider, model, and history choices determine cache reuse in the child.

## Known Limitations and Deferred Work

- **A selected profile can omit the SDK server** — initialization fails at its configured bound and names that profile; retain the SDK app bundle or an equivalent server row.
- **No mid-turn cancel or per-prompt result** — abandoning an owned activity means closing the runtime; model outcomes remain in session events.
- **Trusted patches can violate stdout purity** — the shipped SDK profile writes only protocol frames, but arbitrary user plugins own their output behavior.
- **Client→server notifications and server→client requests are unimplemented** on both wire ends.
