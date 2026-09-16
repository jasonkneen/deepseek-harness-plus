# @deepseek-ai/dsh-engine-session-demo

English | [中文](README.zh.md)

Experimental whole-session engine runner. The `dsh-engine-session` bin boots the [engine-session leaf](../../../examples/engine-session/README.md), whose composition mounts NO agent loop: the entire session runs through one delegation backend — the official Claude Agent SDK (`claude-code`) or the official `codex app-server` (`codex`) — while the harness owns the durable session. The user prompt, the engine's final answer, and the turn outcome are logged as ordinary session events, and the session is flushed to persistence before exit. Native OAuth authenticates both engines; no API key is required.

## Usage

```sh
dsh-engine-session [--config path] <claude-code|codex> <task...>
```

Without `--config`, the bin resolves the sibling `examples/engine-session/cordis.yml` leaf; `DSH_SNAPSHOT` replay selects `cordis.snapshot.yml` and skips `.env` so a stray key cannot trigger a real engine run.

## Model Experience

Indirectly, through the composed delegation backend: the engine receives the task text as one fresh run inside its own process, with its native system prompt, tools, and permissions. The bin contributes no model-visible text of its own.

#### KV Cache effect

None; each run is a fresh engine process, and only the recorded answer enters the harness session log.

## Known Limitations and Deferred Work

- **One task per invocation** — the bin drives a single turn to quiescence and exits; interactive multi-turn sessions require `continuation` on the backend rows and repeated invocations.
- **Engine tool activity is invisible** — the session log records the prompt, final answer, and outcome only; the engine's internal tool calls never become session events.
- **Native login is a precondition** — a logged-out `claude` or `codex` surfaces as a run error; the bin provides no login flow.
