# multi-provider 示例

[English](README.md) | 中文

[`@deepseek-ai/dsh-multi-provider`](../../packages/bundle/multi-provider/README.zh.md) pack 组合包的可运行参考：在 agent spine 之上用通用 pi-ai 适配器激活三个基于密钥的 provider（Gemini、MiniMax、Kimi），并组合 Claude Code 与 Codex 委派后端，作为一个 leaf 交付。`cordis.yml` 是组合基座；`cordis.snapshot.yml` 是它的回放孪生文件，供无密钥快照套件使用。

## 这个 leaf 证明什么

- **基于密钥的 provider 注册并可服务。** `llm-pi-ai` 配置行激活 `google`（Gemini，`GOOGLE_API_KEY`）、`minimax`（MiniMax，`MINIMAX_API_KEY`）、`kimi-coding`（Kimi，`KIMI_CODING_API_KEY`）与 `anthropic`（Claude API，`ANTHROPIC_API_KEY`），带精选模型目录。密钥在每次请求时通过 credential 通道解析——不内联任何密钥。选择基于密钥的路由但缺少对应密钥时，会以 `MISSING_CREDENTIAL` 明确指出缺哪个密钥。
- **委派后端以原生认证加载。** `claude-code`（官方 Claude Agent SDK）与 `codex`（官方 `codex app-server --stdio`）provider 在宿主上组合，直到工具调用才启动子进程。它们的工具行以 `disabled: true` 交付（随发行版 profile 的姿态）；在行的副本中移除该标记即可把 `subagent_claude_code`／`subagent_codex` 暴露给所有 agent。
- **引擎是可选的 provider。** `dsh-llm-engine` 适配器把 `claude-code` 与 `codex` 注册到 LLM seam 上（模型 `native`）：在这些路由上的会话，每一回合都通过本地 CLI 以其 OAuth 状态运行——与 web Models 选择器走的是同一条路径。
- **端到端。** 无密钥套件通过 Loader 启动真实组合并固定 provider 列表；带密钥套件对每个 provider 跑一次真实任务、对每个后端跑一次真实委派。

## 运行

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

两个命令都会启动本 leaf 的 `cordis.yml`；演示 bin 位于 `packages/examples/multi-provider-demo/src/bin.ts`。

## 凭据

`GOOGLE_API_KEY`、`MINIMAX_API_KEY`、`KIMI_CODING_API_KEY` 与 `ANTHROPIC_API_KEY` 在每次请求时通过 credential 通道解析：进程环境优先，其次受管凭据文档（`$DSH_HOME/.credentials.yaml`，即 web Models 页面写入的文件）。Claude Code 与 Codex 不需要密钥——它们使用各自的原生 OAuth 状态（`claude` 登录 claude.ai，`codex` 登录 ChatGPT）。

## 测试

| 套件 | 密钥 | 固定什么 |
|---|---|---|
| `tests/providers.spec.ts` | 无 | 真实 Loader 启动：三条路由带精选目录、两个后端已注册、禁用工具行不在工具面中；leaf providers 字典与 pack bundle patch 保持同步 |
| `tests/listing.snapshot.ts` | 无 | 演示 bin `providers` 的 stdout，逐字节比对（用 `pnpm run test:snapshot:refresh -- multi-provider` 重新记录） |
| `tests/providers.e2e.ts` | 按 provider | 通过演示 bin 对每个 provider 跑一次真实任务（`Reply with exactly: PONG`），缺少密钥时自行跳过 |
| `tests/delegation.e2e.ts` | 无（原生 OAuth） | 通过真实组合对每个后端跑一次真实委派，产品 CLI 缺失或未登录时自行跳过 |

## 已知限制

- 委派是单任务而非整会话：每次运行都是一次全新的查询／线程（见各后端 README）。用 Claude Code 或 Codex 驱动整个会话是另一个实验性表面。
- 这里的 `llm-pi-ai` providers 字典必须与 `packages/bundle/multi-provider/cordis.patch.yml` 一致；`tests/providers.spec.ts` 用测试机制强制两者同步。
