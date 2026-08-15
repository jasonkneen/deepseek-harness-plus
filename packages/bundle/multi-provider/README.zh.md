# `@deepseek-ai/dsh-multi-provider`

[English](README.md) | 中文

以 profile 组合包形式交付的多 provider 包：[`cordis.patch.yml`](cordis.patch.yml) 是叠在 [`dsh-base`](../base/README.md) 之上的可选层，在休眠挂载的 [`dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.md) 适配器上激活第三方模型 provider，并组合 [Claude Code](../../subagent/subagent-claude-code/README.md) 与 [Codex](../../subagent/subagent-codex/README.md) 委派后端。把 `@deepseek-ai/dsh-multi-provider` 加到 profile 的 `dsh.profile.bundles`（位于 `@deepseek-ai/dsh-base` 之后）即可启用整个包；移除即可整体卸载。该包没有运行时 API；profile 组合器通过 manifest 的 `dsh.bundle.patch` 字段解析 patch，绝不通过代码。

## 该 patch 做什么

- **激活三条基于密钥的 provider 路由**（位于 `dsh-llm-pi-ai` 上），每条带一份精选模型目录（未设置的字段从已安装的 pi-ai 目录取默认值：端点、线上协议、容量）：

| 路由 | Provider | 密钥 | 模型 |
|---|---|---|---|
| `google` | Gemini | `GOOGLE_API_KEY` | `gemini-2.5-flash`、`gemini-2.5-pro`、`gemini-3-pro-preview` |
| `minimax` | MiniMax | `MINIMAX_API_KEY` | `MiniMax-M2.7`、`MiniMax-M2.7-highspeed`、`MiniMax-M3` |
| `kimi-coding` | Kimi（Moonshot） | `KIMI_CODING_API_KEY` | `kimi-for-coding`、`kimi-for-coding-highspeed`、`k3` |
| `anthropic` | Claude（API） | `ANTHROPIC_API_KEY` | `claude-opus-5`、`claude-sonnet-4-5`、`claude-haiku-4-5` |

  密钥在每次请求时通过 credential 通道解析（进程环境优先于受管凭据文档）——patch 里不内联任何密钥。`llm-pi-ai:` settings 小节仍可无重启地覆盖每次请求的事实；删除某路由的 `models` 列表则改为提供该路由的完整已安装目录。

  **认证路径，各一句话：** `anthropic` 是基于密钥的 Claude API（Anthropic Messages 协议）——未设置 `ANTHROPIC_API_KEY` 就选择它，会以 `MISSING_CREDENTIAL` 明确指出缺哪个密钥。Claude Code 与 Codex 是 agent 而不是模型端点，以原生 OAuth（你的 claude.ai／ChatGPT 登录态）认证：[`dsh-llm-engine`](../../llm/llm-engine/README.md) 适配器把两者注册为 LLM seam 上的可选 provider 路由（web Models 选择器会列出它们，模型为 `native`），在这些路由上的会话每一回合都通过本地 CLI 运行——完全不需要任何密钥。

- **组合委派后端** `@deepseek-ai/dsh-subagent-codex` 与 `@deepseek-ai/dsh-subagent-claude-code`，其面向模型的工具行（`subagent_codex`、`subagent_claude_code`）存在但 `disabled: true`——即随发行版 profile 的姿态：provider 在宿主上加载，直到工具调用才启动子进程，默认不向任何组合出来的 agent 增加委派工具。在后续 patch 层或 profile 中移除 `disabled: true` 即可把后端暴露给所有 agent；Agent Preset 可以按 agent 限定暴露范围。

## 使用该包

1. 把 `@deepseek-ai/dsh-multi-provider` 加入 profile 的 `dsh.profile.bundles`（位于 `@deepseek-ai/dsh-base` 之后）。
2. 在环境变量或受管凭据文档中设置 `GOOGLE_API_KEY`、`MINIMAX_API_KEY`、`KIMI_CODING_API_KEY` 和／或 `ANTHROPIC_API_KEY`（与 `DEEPSEEK_API_KEY` 同一通道）；引擎 provider 什么都不需要——只要 `claude`／`codex` 已登录即可。
3. 启动 profile；Models 选择器会列出新 provider，`ctx.llm.listProviders()`／`listModels()` 提供路由目录。

可运行的参考组合是 [`examples/multi-provider`](../../../examples/multi-provider/README.md)：它在 agent spine 之上启动该包，无密钥即可验证路由注册，有密钥时对每个 provider 运行一次真实任务。

## 模型体验

通过插入的行间接产生影响：pi-ai 适配器把对话请求路由到已激活的 provider，委派工具行把后端调用暴露给启用它们的 agent。该包自身不贡献任何模型可见文本。

#### KV Cache 影响

无直接影响；每条插入行的影响由其所属的包负责。

## 已知限制与暂缓事项

- **patch 会替换整行 `config`**：profile 覆盖必须重述该行需要保留的每个字段；不存在深度合并层。后续 patch 若想扩展 `llm-pi-ai` 的 providers 字典，必须重述全部三条路由。
- **后端工具行默认禁用**——启用会改变 profile 内每个 agent 的模型可见工具面；需要时请用 Agent Preset 限定范围，而不是一刀切启用。
- **委派仍是单任务而非整会话**——组合进来的后端每次运行只回答一个自包含任务（见各后端 README 的 Known Limitations）；用 Claude Code 或 Codex 驱动整个会话是另一个实验性表面。
