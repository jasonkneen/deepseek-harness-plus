# @deepseek-ai/dsh-subagent-acp

English | [中文](README.zh.md)

The ACP provider runs each subagent in a fresh subprocess and drives it as an Agent Client Protocol client. It is the out-of-process alternative to spawn and fork: the child has its own runtime, session, model configuration, and tools.

## Start and ownership

`start(request)` resolves the child's working directory, then performs `spawn` → ACP `initialize` → `newSession` before it fulfills. Fulfillment therefore means a remote session is ready and ownership has transferred to the caller. A spawn, initialization, new-session, or pre-publication cancellation failure ordinarily rejects after the subprocess is reaped; when cleanup itself rejects, ordered safe facts preserve startup plus teardown for an ordinary failure, or teardown alone after cancellation, without claiming whole-tree quiescence. A working-directory resolution failure rejects before anything is spawned. Non-cancellation rejections expose only fixed provider, stage, and category facts in their Error message; the original failure remains on the internal cause chain and in Host diagnostics.

The working directory is the configured `cwd` override when set, else the delegating parent session's cwd — never the server process's own cwd, because one server process serves sessions from many workspaces. The parent-derived value must be an absolute path naming a directory the harness can enter (search permission — what a subprocess cwd needs), and the same resolved path becomes both the subprocess cwd and the ACP `session/new` workspace.

The returned run id is minted in the parent namespace. The child server's session id remains private to ACP wire calls because ACP guarantees it only within that fresh child process; using it as the parent lifecycle id could collide with another remote run or a local agent.

After publication, the provider sends the prompt and collects streamed `agent_message_chunk` text into `SubagentResult.output`. A prompt/transport or early-process failure resolves with `stopReason: 'error'` and a safe `SubagentResult.diagnostic`; local cancellation resolves as `aborted` without failure detail. Partial assistant text remains in `output`, separate from the diagnostic.

`dispose()` is idempotent. It removes the signal listener, requests ACP cancellation when possible, then runs this backend's own teardown ladder (`disposeAcpChild`) over the seam's verbs: close stdin and wait `disposeEofGraceMs` for cooperative quiescence, then invoke the handle's `terminate()` escalation (SIGTERM, the spawn grace, SIGKILL — Windows force-terminates directly) and await the subprocess owner's whole-tree exit proof. Every run uses a fresh process; process pooling is not implemented.

## Capabilities and context

ACP advertises no start-time capabilities because this process cannot apply `request.agentOptions` or enforce the remote child's depth, tool filter, persona, or structured-output runtime. It also reports `inheritsParentContext: false`: the remote session starts fresh, and the only parent-derived input is the workspace cwd described above — no conversation context crosses the process boundary.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `providerName` | `acp` | Registry name on `ctx.subagents`. |
| `command` | required | Executable spawned for each run. |
| `args` | `[]` | Command arguments. |
| `cwd` | parent session cwd | Working-directory override for the child process and its ACP session; must be non-empty, a relative value resolves against the harness launch directory at load, and the result must name a directory the harness can enter. |
| `permission` | `reject` | Auto-answer permission requests by rejecting or choosing the first `allow_once` or `allow_always` option. |
| `env` | `{}` | Explicit child environment layered over a credential-scrubbed parent environment. |
| `disposeEofGraceMs` | `6000` | Positive grace after stdin EOF before platform termination; it cannot exceed [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md). |
| `disposeGraceMs` | `3000` | Positive bound for observing structured process facts after failure and, on POSIX, the SIGTERM-to-SIGKILL grace (Windows force-terminates directly); it cannot exceed [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md). |

A DeepSeek Harness child uses the product launcher and an explicit absolute `DSH_HOME`. The isolated home prevents a nested runtime from discovering the launching person's profiles or credentials; the generic ACP provider does not impose this requirement on non-DSH agents.

```yaml
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: acp
    command: dsh
    args: ['--profile', 'acp', '--patch', '/absolute/path/to/acp.patch.yml']
    permission: reject
    env:
      DSH_HOME: /absolute/path/to/isolated-child-home
      DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
```

## Stop-reason mapping

| ACP | Harness | Additional diagnostic |
|---|---|---|
| `end_turn` | `completed` | None. |
| `max_tokens` | `max-tokens` | Only a contributing permission decision. |
| `refusal` | `refusal` | Only a contributing permission decision. |
| `cancelled` | `aborted` | Only a contributing permission decision; local cancellation never adds one. |
| `max_turn_requests` | `error` | `remote-limit` with the closed stop reason. |
| unknown | `error` | Fixed `unknown`; the wire value is not copied. |

## Failure diagnostics

Failure diagnostics for generic error paths have a fixed field order:

```text
Subagent failure (provider: ACP; stage: <stage>; category: <category>; stop reason: <reason>; exit code: <code>; signal: <signal>)
```

Unavailable optional fields are omitted. The provider derives `initialize`, `new-session`, `prompt`, `process`, or `teardown` at the operation that owns the failure. Categories distinguish configuration, protocol or transport failure, process start/exit, remote limits, and the fixed unknown fallback. Exit code and signal come only from the managed subprocess outcome; stderr, exception messages, task text, tool input, paths, environment values, credentials, and protocol payloads never enter the diagnostic. The shared result boundary limits the complete text to 4096 UTF-8 bytes.

When a run requested permission and did not complete, a fixed permission line records the configured policy, the ACP closed tool kind, and whether the provider allowed or denied it. Tool titles, raw input, locations, and option text are excluded. For `max-tokens`, `refusal`, or remote `aborted`, this is the complete diagnostic because the public stop reason already carries the terminal fact; generic error paths put it after the failure line. Successful results and local cancellation omit it. A permission-diagnosed remote `aborted` result remains `aborted`; foreground presentation includes its diagnostic, while the one-shot Job adapter classifies that diagnostic-bearing remote abort as failed instead of conflating it with local cancellation.

## Process boundary

The child spawns through the [`dsh-subprocess`](../../subprocess/subprocess/README.md) seam: credential-shaped ambient variables and ambient `DSH_*` names are removed by the shared scrub, then explicit `config.env` values merge after it (an intended `DEEPSEEK_API_KEY` survives, and a `DSH_*` deployment fact such as `DSH_PERMISSION_MODE` reaches the child the same way — the scrub drops only its stale ambient namesake), stderr is inherited to the parent's own stream, and disposal applies this plugin's EOF window before the subprocess-owned SIGTERM→SIGKILL escalation and whole-tree join. The ACP wire is the real serialization boundary; same-process subagent values are not defensively cloned.

The package has no default export. Cordis loader unwrapping would otherwise hide the named `inject` metadata; see [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md).

## Model Experience

### Child-agent request

#### What the model sees

The remote child receives the standalone task content through ACP plus its own process's configured system prompt, tools, and fresh session. It receives no parent conversation. This provider advertises no optional start-time capabilities, so the local service rejects requests for `agentOptions`, persona, tool filtering, depth enforcement, or structured output instead of silently omitting them.

#### Token effect

The child pays for an independent full context and its own multi-step history. These tokens never enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Each ACP child can reuse only prefixes identical under its own provider, model, composition, and history; child steps otherwise grow append-only.

### Parent tool result, indirectly

#### What the model sees

Through `dsh-tool-subagent`, the parent receives only the child's final streamed assistant text or that consumer's exact stop-reason error, not intermediate messages or tool traffic. Non-completed results present the safe diagnostic before separately preserved partial assistant output. A request already cancelled before publication becomes exactly `Error: subagent request was aborted before the ACP child started`; another start failure contains only the fixed `Subagent failure (...)` line.

#### Token effect

Parent input grows only by the final result or error, which is data-dependent and retained until compaction. This provider adds no parent schema itself.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **A fresh process per run** — persistent-process pooling is a future optimization ([the seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md)).
- **Local workspaces only** — the resolved cwd is a local path handed to a child on the same machine; workspace mapping for a remote ACP agent would need its own backend capability and is not designed here.
- **No optional start-time capabilities** — this provider cannot apply the local harness's `agentOptions`, `outputSchema`, depth cap, tool filter, or persona inside the remote process, so it advertises none and the service rejects requests that require them.
- **Only committed `agent_message_chunk` text is collected** — the automation server keeps reasoning, tool activity, plans, and other trace data in the child session log rather than emitting them on ACP.
- **Permission prompts are auto-answered** (`permission: allow | reject`) — no human is surfaced a child's `session/request_permission`.
