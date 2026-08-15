# engine-session example

English | [中文](README.zh.md)

Runnable demo of the experimental whole-session mode: the harness agent loop is **not** composed; the entire session runs through one delegation engine — [Claude Code via the official Agent SDK](../../packages/subagent/subagent-claude-code/README.md) (`claude-code`) or [Codex via the official `codex app-server`](../../packages/subagent/subagent-codex/README.md) (`codex`) — with the harness owning the durable session. The engine bin at `packages/examples/engine-session-demo/src/bin.ts` creates the session, logs the user prompt, delegates the whole task, logs the engine's final answer and the turn outcome as ordinary session events, and flushes the session to JSONL persistence.

This is the documented experimental path from the [`@deepseek-ai/dsh-multi-provider`](../../packages/bundle/multi-provider/README.md) pack: the same backends that answer one delegation each now answer an entire session, and the transcript stays in the harness's own session log. It is NOT the harness agent loop — no tool execution, sandbox, approval, or model routing runs here; the engine's own loop is authoritative inside the run.

## Run it

```sh
# The whole session runs on Claude Code (native claude.ai OAuth):
pnpm run demo:engine-session claude-code "fix the failing test in this repo"

# The whole session runs on Codex (native ChatGPT OAuth):
pnpm run demo:engine-session codex "summarize the git log"
```

Both engines authenticate with their native OAuth state — no API key. The session transcript persists under the leaf's `.sessions/` (zstd JSONL, like every other harness session).

## Tests

| Suite | Keys | What it pins |
|---|---|---|
| `tests/engine.spec.ts` | none | Real Loader boot: both engines register, a session is created, and the full transcript sequence (turn/start → user/message → assistant/message → turn/end) appends and flushes without any backend run |
| `tests/engine.e2e.ts` | none (native OAuth) | One whole session per engine through the real bin: stdout answers PONG and the durable `.sessions` JSONL contains the user prompt, the engine answer, and a `completed` turn end; self-skips when the product CLI is missing or logged out |

## Known Limitations (experimental)

- **One delegation per session** — the session is a single user prompt answered once; multi-turn continuation, streaming progress, and live tool echo are not implemented.
- **No harness loop services** — tools, sandbox, approval, compaction, and model routing do not run; the engine's own loop, tools, and permissions are authoritative.
- **Final-text fidelity** — only the engine's final answer is logged; reasoning and intermediate tool activity stay product-local.
- The leaf's rows are the minimum the engines need; the multi-provider leaf is the composition to grow from when a session needs both engines and harness providers.
