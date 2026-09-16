# @deepseek-ai/dsh-llm-engine

English | [中文](README.zh.md)

LLM-seam adapter for the local engine CLIs. Registers the `claude-code` and `codex` provider routes on `ctx.llm`, backed by the matching [`ctx.subagents`](../../subagent/subagent/README.md) backends: [`dsh-subagent-claude-code`](../../subagent/subagent-claude-code/README.md) runs the official Claude Agent SDK, [`dsh-subagent-codex`](../../subagent/subagent-codex/README.md) runs the official `codex app-server`. Selecting one of these routes as a session's provider — in the web Models picker, `agent-default-model`, or any model selection — routes every turn through the local CLI with its **native OAuth state (claude.ai / ChatGPT login); no API key of any kind**.

## What the adapter does

`stream()` takes the latest DIRECT user prompt's text (synthetic context injections such as AGENTS.md and skill catalogs are excluded by source kind), starts the matching backend through `ctx.subagents` with a cwd-bearing stub parent, forwards the engine's **live text deltas** as `text-delta` chunks while the run settles, and closes with the assembled final answer and a terminal finish. The engines are agents, not model endpoints: they execute their own tools inside their own process, so the harness loop sees text-only turns and the session log records the answers like any other assistant message. Engine runs are **never retried** (`maxRetries: 0`): a retry would execute the CLI twice.

**Long-lived sessions.** With `continuation: true` (plugin config plus the matching backend rows), the adapter keys an engine session per harness session id and resumes it on every later turn: Claude Code via the SDK's `resume` (`persistSession`), Codex via `thread/resume` on a persistent thread. The engine then remembers earlier turns of the same harness session — one conversation, not fresh-per-turn.

Refusal surfaces (all error finishes, no engine process started):

- **No user text** — `EMPTY_PROMPT`: the engines need a non-empty instruction.
- **Auxiliary purposes** — `UNSUPPORTED_PURPOSE`: compaction and session-title calls would spawn a full agent run for a side task.
- **Non-completed results** — `ENGINE_FAILURE` (or `ABORTED` for explicit cancellation), `EMPTY_RESPONSE` for a completed run with no text.

Each route advertises its **real model catalog** (`claude-code`: Claude Opus/Sonnet/Haiku family; `codex`: the installed app-server's GPT-5.3 Codex models) plus a `native` choice meaning "the CLI's own configured default — no override sent". Selecting a catalog model sends the id to the engine (SDK `model` / app-server `turn/start model`). Every catalog model advertises selectable **reasoning efforts** (`off`/`low`/`medium`/`high`, plus `xhigh`/`max` for Claude), mapped to the engines' native vocabularies (SDK `effort`/`thinking`, app-server `effort`); the harness materializes `high` when the caller omits one.

## Composition

The `@deepseek-ai/dsh-multi-provider` bundle mounts this adapter together with the two backends; the runnable reference is [`examples/multi-provider`](../../../examples/multi-provider/README.md). A profile needs `dsh-subagent` (in `dsh-base`) plus the two backend rows and this row:

```yaml
- id: llm-engine
  name: '@deepseek-ai/dsh-llm-engine'

- id: subagent-codex
  name: '@deepseek-ai/dsh-subagent-codex'

- id: subagent-claude-code
  name: '@deepseek-ai/dsh-subagent-claude-code'
```

No keys: `claude` must be logged into claude.ai and/or `codex` into ChatGPT.

## Permission decisions

The engine's native permission flow applies inside its process (Claude Code's approvals, Codex's `approval_policy`); the harness approval seam is not involved. See each backend README's permission posture.

## Model Experience

### Prompt text

#### What the model sees

The engine receives the latest user message text only (`stream()` forwards it as one task in a fresh run, as the Claude Agent SDK `prompt` or the app-server `turn/start` input). It never sees the conversation history, the harness system prompt, or tool schemas; its own native system prompt, tools, and permissions apply inside its process.

#### Token effect

Data-dependent; each engine run pays for an independent context that never enters the harness's derived history beyond the recorded answer.

#### KV Cache effect

None; each run is a fresh engine process with its own provider state.

## Known Limitations and Deferred Work

- **Text-only turns** — engine tool activity stays inside the engine process; the session log records no tool calls for engine turns (streamed text deltas arrive live, tool events do not).
- **Continuation is opt-in and native-stateful** — `continuation: true` persists Claude session files and Codex threads under the native CLI config dirs; the one-shot default touches no native state.
- **Host cwd** — engine runs happen in the host process's cwd, not the session's workspace.
- **Auxiliary calls refused** — compaction and session-title generation fail for engine sessions; titles fall back to the fallback rules.
- **Catalog is static** — model lists are curated from the installed SDK/catalog versions; a newer CLI may support models the list does not yet name (the `native` choice always tracks the CLI's own default).
