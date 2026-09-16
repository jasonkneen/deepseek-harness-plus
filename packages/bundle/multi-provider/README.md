# `@deepseek-ai/dsh-multi-provider`

English | [中文](README.zh.md)

The multi-provider pack as a profile bundle: [`cordis.patch.yml`](cordis.patch.yml) is an optional layer over [`dsh-base`](../base/README.md) that activates third-party model providers on the dormant [`dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.md) adapter and composes the [Claude Code](../../subagent/subagent-claude-code/README.md) and [Codex](../../subagent/subagent-codex/README.md) delegation backends. Add `@deepseek-ai/dsh-multi-provider` to a profile's `dsh.profile.bundles` after `@deepseek-ai/dsh-base` to enable the pack; remove it to drop everything below. The package has no runtime API; the profile composer resolves the patch through the `dsh.bundle.patch` manifest field.

## What the patch does

- **Activates three key-based provider routes** on `dsh-llm-pi-ai`, each with a curated model catalog (unset fields default from the installed pi-ai catalog: endpoint, wire protocol, capacities):

| Route | Provider | Keys | Models |
|---|---|---|---|
| `google` | Gemini | `GOOGLE_API_KEY` | `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3-pro-preview` |
| `minimax` | MiniMax | `MINIMAX_API_KEY` | `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M3` |
| `kimi-coding` | Kimi (Moonshot) | `KIMI_CODING_API_KEY` | `kimi-for-coding`, `kimi-for-coding-highspeed`, `k3` |
| `anthropic` | Claude (API) | `ANTHROPIC_API_KEY` | `claude-opus-5`, `claude-sonnet-4-5`, `claude-haiku-4-5` |

  Keys resolve per request through the credential seam (process environment over the managed credentials document) — no key is inlined in the patch. The `llm-pi-ai:` settings section still overrides per-request facts without a restart; deleting a route's `models` list serves that route's full installed catalog.

  **Auth paths, one sentence each:** `anthropic` is the KEY-based Claude API (Anthropic Messages protocol) — selecting it without `ANTHROPIC_API_KEY` fails loud with `MISSING_CREDENTIAL` naming the key. Claude Code and Codex are agents, not model endpoints, and authenticate with native OAuth (your claude.ai / ChatGPT login): the [`dsh-llm-engine`](../../llm/llm-engine/README.md) adapter registers them as selectable provider routes on the LLM seam (the web Models picker lists them, model `native`), and every turn of a session on those routes runs through the local CLI — no key of any kind.

- **Composes the delegation backends** `@deepseek-ai/dsh-subagent-codex` and `@deepseek-ai/dsh-subagent-claude-code` with their model-facing tool rows (`subagent_codex`, `subagent_claude_code`) present but `disabled: true` — the shipped-profile posture: the providers load on the host, start no child process until a tool call, and no composed agent grows the delegation tools by default. Remove `disabled: true` in a later patch layer or a profile copy of the row to expose a backend to every agent; Agent Presets can scope exposure per agent.

## Using the pack

1. Add `@deepseek-ai/dsh-multi-provider` to the profile's `dsh.profile.bundles` (after `@deepseek-ai/dsh-base`).
2. Set `GOOGLE_API_KEY`, `MINIMAX_API_KEY`, `KIMI_CODING_API_KEY`, and/or `ANTHROPIC_API_KEY` in the environment or the managed credentials document (same seam as `DEEPSEEK_API_KEY`); the engine providers need nothing — `claude`/`codex` must only be logged in.
3. Boot the profile; the Models picker lists the new providers, and `ctx.llm.listProviders()`/`listModels()` serve the route catalogs.

The runnable reference composition is [`examples/multi-provider`](../../../examples/multi-provider/README.md): it boots the pack over the agent spine, proves the routes register keyless, and runs one real task per provider when keys are present.

## Model Experience

Indirectly, through the inserted rows: the pi-ai adapter routes conversation requests to the activated providers, and the delegation tool rows expose backend calls to agents that enable them. The bundle contributes no model-visible text of its own.

#### KV Cache effect

None directly; each inserted row's package owns its effect.

## Known Limitations and Deferred Work

- **A patch replaces whole row configs** — profile overrides must restate every field a row keeps; there is no deep-merge layer. A later patch that wants to extend the `llm-pi-ai` providers dict must restate all three routes.
- **Backend tool rows ship disabled** — enabling them changes the model-facing tool surface of every agent in the profile; scope with Agent Presets instead of a blanket enable where that matters.
- **Delegation remains per-task, not whole-session** — the composed backends answer one self-contained task per run (see each backend README's Known Limitations); driving an entire session through Claude Code or Codex is a separate experimental surface.
