# @deepseek-ai/dsh-multi-provider-demo

English | [中文](README.zh.md)

Multi-provider pack demo app. The `dsh-multi-provider-demo` bin boots the [multi-provider leaf](../../../examples/multi-provider/README.md) — the agent spine plus the [`dsh-multi-provider`](../../bundle/multi-provider/README.md) pack — and either lists the registered LLM providers with their model catalogs or runs one task through a chosen provider and prints the final assistant text.

## Usage

```sh
dsh-multi-provider-demo [--config path] providers
dsh-multi-provider-demo [--config path] run --provider <name> [--model <id>] <task...>
```

The `providers` listing is keyless and deterministic. `DSH_SNAPSHOT` replay selects the sibling `cordis.snapshot.yml` and skips `.env`, so a stray key cannot trigger a real model call; `run` needs the matching provider key in the environment or `.env`.

## Model Experience

Indirectly, through the composed spine and pack: the selected provider adapter owns the request, and the spine's prompt and tool plugins own the model-visible text. The bin contributes none of its own.

#### KV Cache effect

None; each `run` boots one fresh agent and session.

## Known Limitations and Deferred Work

- **One task per `run`** — the bin drives a single fresh agent to quiescence and exits; there is no interactive session or resume.
- **Keys select behavior at run time** — a missing provider key fails the `run` command at the first model call; the listing cannot prove a provider is usable.
