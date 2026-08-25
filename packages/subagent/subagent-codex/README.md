# @deepseek-ai/dsh-subagent-codex

English | [中文](README.zh.md)

This package registers a Profile-named Codex subagent provider whose default name is `codex`. Each accepted run starts the official package-local Codex wrapper with `app-server --stdio` in the delegating Session's workspace, creates one ephemeral Codex thread, submits one self-contained text task, and returns either the selected final answer or a separate safe failure diagnostic through the shared [`dsh-subagent`](../subagent/README.md) result contract.

## Start and ownership

`start(request)` accepts only a non-empty sequence of text blocks and derives the child cwd from the parent Session. It then spawns the fixed command through [`dsh-subprocess`](../../subprocess/subprocess/README.md), performs `initialize` → `initialized`, maps the Profile-selected mode and optional model into official `thread/start` fields beside `{ cwd, ephemeral: true }`, and publishes the run only after Codex returns a valid ephemeral thread. A failure or cancellation before publication closes the wire, terminates the managed process tree, waits for it to exit, and rejects `start()`. Non-cancellation rejections expose only the fixed `initialize` or `thread-start` stage plus an already observed process outcome; raw product and Host errors remain on internal cause chains.

The published `run.result` starts exactly one turn. It accepts only notifications for that run's thread and turn, then waits for the authoritative `turn/completed` terminal notification. The latest `agentMessage` with `phase: "final_answer"` wins; when Codex emits no explicit final phase, the latest message with `phase: null` is the compatibility fallback. Commentary never replaces either answer, and a successful turn with no nonblank answer settles as an error.

For command and file approvals, the unattended provider selects a non-approval decision offered by the request, preferring `cancel`; the stable 0.149.1 request shape without an offered-decision list falls back to `decline`. It answers permission requests with an empty turn-scoped permission set, answers user-input requests with no answers, and declines MCP elicitation. A request with no legal unattended response, or any unknown server request, fails the run. The wire records only the effective mode, request category, decision, and fixed safe reason. It also recognizes declined command/file items and structured `sandboxError` terminals. Product stderr is forwarded unchanged to the Host but is never classified or copied into the diagnostic.

Local cancellation wins the result race and maps to `aborted`. Failed turns use the coarse categories `limit`, `access-policy`, `service`, `transport`, `product-error`, `invalid-result`, or `unknown`; an early app-server exit uses `process`. Applicable connection and stream failures retain a numeric `httpStatusCode`. The diagnostic also names `turn-start`, `turn`, or `process` and independently includes available exit code and signal without copying raw fields. `contextWindowExceeded` remains `max-tokens`; every other remote interruption or failure remains `error`, and the provider produces no `refusal`. A contributing structured permission decision follows the failure line. Successful and locally cancelled runs omit both facts.

`dispose()` is idempotent: it requests a best-effort `turn/interrupt` with both current ids when they are known, closes the JSON-RPC wire, ends stdin, invokes the shared process-tree termination escalation, waits for whole-tree exit, and detaches the stderr observer. Independent cleanup rejection uses the fixed `teardown` stage and any available process outcome. When startup and rollback both fail, the top-level aggregate message preserves both safe stage lines while the raw failures remain internal.

## Capabilities and context

The provider advertises no optional start-time capabilities and reports `inheritsParentContext: false`. The shared service rejects `request.agentOptions` for this provider. Codex receives the standalone text task and the parent Session cwd, but not the parent conversation, persona, tool filter, depth policy, or structured-output contract. The ephemeral Codex thread id and turn id stay private to this run and are never persisted in the parent Session.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `providerName` | `codex` | Non-empty registry name on `ctx.subagents`; each mounted instance needs a unique value. |
| `model` | native Codex settings | Optional non-empty native model name fixed for every thread from this Provider instance; omission sends no app-server override. |
| `env` | `{}` | Explicit child environment layered over the subprocess seam's credential-scrubbed parent environment. |
| `permissionMode` | `never` | Native non-interactive approval and sandbox mode fixed for every thread from this Provider instance. |
| `disposeGraceMs` | `3000` | Positive finite grace in milliseconds, no greater than [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md), between the shared process-tree owner's termination tiers; disposal then waits for whole-tree exit. |

| `permissionMode` value | `thread/start` fields | Native behavior |
|---|---|---|
| `never` | `approvalPolicy: never`; sandbox omitted | Never ask for approval; execution failures return to the model under the native sandbox. |
| `approve-for-me` | `approvalPolicy: on-request`, `approvalsReviewer: auto_review`, `sandbox: workspace-write` | Route permission requests through Codex automatic review without a human. |
| `dangerously-bypass-approvals-and-sandbox` | `approvalPolicy: never`, `sandbox: danger-full-access` | Skip approval and sandbox enforcement; this value must be selected explicitly. |

Production resolves the `codex` bin declared by its pinned `@openai/codex@0.149.1` dependency and launches that JavaScript wrapper with the current Node executable. The wrapper selects the matching native platform payload; the provider neither inspects nor falls back to a host `codex` on `PATH`. Native Codex configuration and authentication remain authoritative through the parent cwd, `HOME`, and `CODEX_HOME`. A configured `model` is passed unchanged on each ephemeral `thread/start`; omission leaves the field absent, and the Provider does not discover models, rewrite aliases, select `modelProvider` or `serviceTier`, or set a fallback. The selected permission mode remains the only other thread-level override. The plugin does not create `CODEX_HOME`, log in, or probe an account. Credential-shaped ambient variables are removed by the subprocess seam before the explicit `env` overlay is applied.

This package is an optional Profile Bundle. Install it into the target Profile, then restart that Profile; installation brings the official wrapper and one compatible native platform payload into that Profile, while the declared `cordis.patch.yml` layer registers only the dormant `codex` Host provider and starts no Codex process. Removing the package withdraws that provider and its private runtime closure on the next Profile start.

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-codex
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-codex
dsh --profile <name>
```

Installation controls Host availability, not model permission. The Bundle supplies the dormant default `codex` row; the Profile may replace that row's complete config or mount additional rows with distinct `providerName`, `model`, `permissionMode`, and `env` values. Loading an instance starts no Codex process until a bound tool calls it. Each `dsh-tool-subagent` row names one provider and needs its own `toolName`, so the model sees static tools rather than a dynamic provider or model selector. Full Agent Presets carry a matching default product tool row with `disabled: true`; copy a preset and remove that field to expose `subagent_codex` only to agents composed from the copy. Its `one-shot` policy keeps omitted or `false` `run_in_background` calls in the foreground, while explicit `true` returns a parent-owned Job id for `job_output` or `job_kill`. The base host and full presets already provide the generic Job registry and controls.

The standalone composition below shows the complete explicit capability. A Profile based on `@deepseek-ai/dsh-base` keeps its existing Job rows, adds the product provider and tool rows, and does not mount duplicate Job services.

```yaml
- id: subagent-codex-safe
  name: '@deepseek-ai/dsh-subagent-codex'
  config:
    providerName: codex-safe
    model: approved-review-model
    permissionMode: never
    env:
      OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY

- id: subagent-codex-bypass
  name: '@deepseek-ai/dsh-subagent-codex'
  config:
    providerName: codex-bypass
    model: approved-edit-model
    permissionMode: dangerously-bypass-approvals-and-sandbox
    env:
      OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY
```

```yaml
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'

- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'

- id: tool-subagent-codex-safe
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: codex-safe
    toolName: subagent_codex_safe
    backgroundMode: one-shot
    maxDepth: provider-managed

- id: tool-subagent-codex-bypass
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex-bypass
    toolName: subagent_codex_bypass
    backgroundMode: one-shot
    maxDepth: provider-managed
```

## Product compatibility and evidence

The production wire intentionally implements only the app-server methods required by this one-shot contract. The runtime dependency and all six optional-dependency aliases are pinned to `@openai/codex@0.149.1` / `codex-cli 0.149.1`. A normal install selects one payload for the current OS and CPU. For the current darwin-arm64 payload, `npm pack --dry-run --json @openai/codex@0.149.1-darwin-arm64` reports 114,152,335 packed bytes and 282,491,555 unpacked bytes. That package contains native `codex`, `codex-code-mode-host`, `rg`, and `zsh` resources; other platforms may differ, and these values are disclosure rather than an installation threshold.

Generated schema evidence pins the optional `ThreadStartParams.model` field, while package tests cover representative error groups, applicable HTTP status, six lifecycle stages, process outcomes, stop-reason mapping, unknown fallback, sanitization, structured permission ordering, cancellation, concurrency, and cleanup aggregation. The keyless real-product test drives the package wrapper against a loopback Responses fixture and observes the package-local argv, omitted-model inheritance, two explicit instance models, exact Bearer key, original task, byte-exact final answer, thread-level `never` overriding ambient `on-request`, automatic-review startup, unattended rejection without file side effects, a real service failure, explicit dangerous-bypass writing in suite-owned temporary storage, process/protocol failure with safe exit facts, and wrapper/native quiescence.

Installing with optional dependencies omitted, using an unsupported platform, or losing the selected payload makes the first delegation fail at `initialize` with the safe `unknown` category and any observed process outcome. Raw wrapper text remains on Host stderr; the provider neither probes a host CLI nor retries with one. An isolated wrapper fixture separately proves the native payload failure and absence of host fallback.

## Model Experience

### Child request

#### What the model sees

The Codex child receives the standalone text blocks as one turn in a fresh ephemeral thread. Its workspace is the parent Session cwd; the selected Provider instance fixes any configured model, environment, non-interactive approval policy, and sandbox mode, while an omitted model and every other product setting come from native Codex configuration. The executable version comes from the Bundle's pinned platform payload.

#### Token effect

The child pays for an independent Codex context and turn. Child tokens do not enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Reuse depends only on Codex's own provider, model, instructions, tools, and ephemeral-thread request.

### Parent scheduling and results, indirectly

#### What the model sees

Through `dsh-tool-subagent`, a foreground call gives the parent the selected final Codex answer or an error containing the stop reason and optional safe diagnostic for a non-completed result. The diagnostic can distinguish a coarse action category, protocol stage, applicable numeric HTTP status, and observed process outcome without copying product prose or stderr. A background call first returns a Job id; the generic job controls later deliver a completion notice, expose the same final answer or failed status detail through `job_output`, and let `job_kill` request cancellation. Codex commentary, reasoning, tool activity, raw stderr, workspace diffs, usage, product ids, commands, paths, and protocol payloads are not copied into the parent Session.

#### Token effect

Foreground input grows by the retained final answer or error. Background input also includes the start acknowledgement, completion notice, and any `job_output`, `job_kill`, or later status results; child tokens still do not enter the parent context. This provider adds no parent tool schema by itself.

#### KV Cache effect

Append-only: foreground adds one result after the reusable parent prefix, while background appends the Job acknowledgement, notice, and later control or collection results. Background scheduling can add a notice-driven turn, but none of these messages rewrites the earlier prefix.

## Known Limitations and Deferred Work

- **One fresh process, thread, and turn per run** — there is no continuation, resume, pooling, progress stream, or product-session persistence.
- **Static instance selection** — Profile rows fix provider names, optional models, and tool bindings; calls cannot choose or change either a provider or model dynamically, and every exposed tool needs a unique `toolName`.
- **Authentication and account state remain native** — the Bundle supplies the CLI but does not create an account, log in, trust a project, or rewrite Codex settings; configuration and authentication failures surface with their lifecycle stage and the safe `unknown` fallback rather than a separate public taxonomy.
- **The native platform payload is required at delegation time** — installs that omit optional dependencies, unsupported platforms, and missing or damaged payloads fail at the first run; there is no host-CLI fallback.
- **Compatibility is pinned by development evidence** — upgrading from the verified 0.149.1 protocol baseline requires regenerating upstream schema evidence and rerunning handshake, answer-selection, approval, cancellation, keyless real-product, and credentialed DeepSeek nonce tests.
- **No human approval path** — known unattended approval requests are denied and unknown server requests fail closed; the three Profile modes never create a DSH interaction channel or per-call allow policy.
- **Assistant payload is final text only** — a failed run may additionally expose the separate safe diagnostic; reasoning, commentary, intermediate messages, tool traffic, usage, raw stderr, and workspace diffs remain outside the parent Session, while generic Job ids, notices, and status come from the shared job runtime.
- **No optional shared capabilities** — `agentOptions`, output schemas, child personas, tool filtering, and harness depth enforcement are rejected by the shared service for this provider.
- **No wall-clock timeout or side-effect rollback** — the caller cancels long work, and files or external systems changed before cancellation are not restored.
