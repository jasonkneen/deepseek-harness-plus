# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## This fork

This repository is a fork of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) that adds third-party providers and local agent engines on top of the upstream tree. The fork's additions live in one commit lineage over `upstream/master`; everything else is upstream.

**Third-party key-based providers.** The [`@deepseek-ai/dsh-multi-provider`](packages/bundle/multi-provider/README.md) bundle activates Gemini, MiniMax, Kimi, and the key-based Claude API on the dormant pi-ai adapter, with curated model catalogs and per-request credential references (`GOOGLE_API_KEY`, `MINIMAX_API_KEY`, `KIMI_CODING_API_KEY`, `ANTHROPIC_API_KEY`) — no adapter code, configuration only.

**Local agent engines as first-class providers.** The [`@deepseek-ai/dsh-llm-engine`](packages/llm/llm-engine/README.md) adapter registers **Claude Code** and **Codex** as selectable providers on the LLM seam — they appear in the web Models picker like any other provider. They authenticate with the native CLIs' OAuth state (claude.ai / ChatGPT), so no API key is needed. Each engine route advertises its real model catalog (Claude Opus/Sonnet/Haiku; GPT-5.3 Codex) with selectable reasoning effort, supports long-lived sessions that resume the same engine conversation across turns (Claude `resume`, Codex `thread/resume`), and streams live text deltas. The subagent seam underneath gained optional `continuation` and `reasoningEffort` capabilities plus a live `updates` channel.

**Runnable demos and tests.** `pnpm run demo:multi-provider providers|run` lists providers and runs one task on any key-based or engine provider; `pnpm run demo:engine-session` runs a whole session through either engine. The `examples/multi-provider` and `examples/engine-session` leaves carry keyless Loader specs, byte-pinned listing snapshots, live per-provider turns, live OAuth delegation, and cross-turn memory e2e suites.

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
