# multi-provider example

English | [中文](README.zh.md)

Runnable reference for the [`@deepseek-ai/dsh-multi-provider`](../../packages/bundle/multi-provider/README.md) pack bundle: the agent spine with three key-based providers (Gemini, MiniMax, Kimi) activated on the generic pi-ai adapter, plus the Claude Code and Codex delegation backends, composed as one leaf. `cordis.yml` is the composition base; `cordis.snapshot.yml` is its replay twin for the keyless snapshot suites.

## What this leaf proves

- **Key-based providers register and serve.** The `llm-pi-ai` row activates `google` (Gemini, `GOOGLE_API_KEY`), `minimax` (MiniMax, `MINIMAX_API_KEY`), `kimi-coding` (Kimi, `KIMI_CODING_API_KEY`), and `anthropic` (Claude API, `ANTHROPIC_API_KEY`) with curated model catalogs. Keys resolve per request through the credential seam — no key is inlined. Selecting a key-based route without its key fails loud with `MISSING_CREDENTIAL` naming the key.
- **Delegation backends load with native auth.** The `claude-code` (official Claude Agent SDK) and `codex` (official `codex app-server --stdio`) providers compose on the host and start no child process until a tool call. Their tool rows ship `disabled: true` (the shipped-profile posture); remove the flag in a copy of the row to expose `subagent_claude_code` / `subagent_codex` to every agent.
- **Engines are selectable providers.** The `dsh-llm-engine` adapter registers `claude-code` and `codex` on the LLM seam (model `native`): sessions on those routes run every turn through the local CLI with its OAuth state — the same path the web Models picker uses.
- **End to end.** The keyless suites boot the real composition through the Loader and pin the provider listing; the keyed suites run a live task per provider and a live delegation per backend.

## Run it

```sh
# List the registered providers and model catalogs (keyless, deterministic):
pnpm run demo:multi-provider providers

# Run one task on a key-based provider (needs the provider's key):
pnpm run demo:multi-provider run --provider google --model gemini-2.5-flash "hello"
pnpm run demo:multi-provider run --provider anthropic --model claude-opus-5 "hello"

# Run the whole task through an engine provider — native OAuth, no key.
# The session's turns run through the local CLI via the engine LLM adapter:
pnpm run demo:multi-provider run --provider claude-code "hello"
pnpm run demo:multi-provider run --provider codex "hello"
```

Both commands boot this leaf's `cordis.yml`; the demo bin lives at `packages/examples/multi-provider-demo/src/bin.ts`.

## Credentials

`GOOGLE_API_KEY`, `MINIMAX_API_KEY`, `KIMI_CODING_API_KEY`, and `ANTHROPIC_API_KEY` resolve per request through the credential seam: the process environment, then the managed credentials document (`$DSH_HOME/.credentials.yaml`, what the web Models page writes). Claude Code and Codex need no key — they authenticate with their native OAuth state (`claude` logged into claude.ai, `codex` logged into ChatGPT).

## Tests

| Suite | Keys | What it pins |
|---|---|---|
| `tests/providers.spec.ts` | none | Real Loader boot: the three routes with the curated catalogs, both backends registered, disabled tool rows absent from the tool surface; leaf providers dict stays in sync with the pack bundle patch |
| `tests/listing.snapshot.ts` | none | Demo bin `providers` stdout, byte-for-byte (re-record with `pnpm run test:snapshot:refresh -- multi-provider`) |
| `tests/providers.e2e.ts` | per provider | One live task per provider through the demo bin (`Reply with exactly: PONG`), self-skipping without its key |
| `tests/delegation.e2e.ts` | none (native OAuth) | One live delegation per backend through the real composition, self-skipping when the product CLI is missing or logged out |

## Known Limitations

- Delegation is per-task, not whole-session: each run is one fresh query/thread (see the backend READMEs). Driving an entire session through Claude Code or Codex is a separate experimental surface.
- The `llm-pi-ai` providers dict here must mirror `packages/bundle/multi-provider/cordis.patch.yml`; `tests/providers.spec.ts` enforces the match mechanically.
