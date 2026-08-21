# @deepseek-ai/dsh-llm-engine

[English](README.md) | 中文

面向本地引擎 CLI 的 LLM seam 适配器。在 `ctx.llm` 上注册 `claude-code` 与 `codex` 两条 provider 路由，由对应的 [`ctx.subagents`](../../subagent/subagent/README.zh.md) 后端支撑：[`dsh-subagent-claude-code`](../../subagent/subagent-claude-code/README.zh.md) 运行官方 Claude Agent SDK，[`dsh-subagent-codex`](../../subagent/subagent-codex/README.zh.md) 运行官方 `codex app-server`。把会话的 provider 选成这两条路由之一——无论是在 web Models 选择器、`agent-default-model` 还是任意模型选择里——每一次回合都会通过本地 CLI 运行，使用其**原生 OAuth 状态（claude.ai／ChatGPT 登录）；完全不需要任何 API 密钥**。

## 这个适配器做什么

`stream()` 取最新一条**直接**用户提示词的文本（AGENTS.md、技能目录这类合成上下文注入按 source kind 排除），通过 `ctx.subagents` 启动对应的后端（带一个只含 cwd 的桩父级），在运行期间把引擎的**实时文本增量**作为 `text-delta` 块转发，最后用组装好的最终回答加一个终止 finish 收尾。引擎是 agent 而不是模型端点：它们在各自进程内执行自己的工具，因此 harness loop 看到的是纯文本回合，会话日志像记录其他助手消息一样记录回答。引擎运行**绝不重试**（`maxRetries: 0`）：重试等于把 CLI 执行两遍。

**长会话。** 开启 `continuation: true`（插件配置加上对应的后端行）后，适配器按 harness 会话 id 为引擎会话建索引，并在后续每一回合恢复它：Claude Code 走 SDK 的 `resume`（`persistSession`），Codex 在持久线程上走 `thread/resume`。于是引擎能记住同一个 harness 会话的早期回合——一段连续对话，而不是每次重新开始。

拒绝面（全部是 error finish，不启动任何引擎进程）：

- **没有用户文本**——`EMPTY_PROMPT`：引擎需要一个非空指令。
- **辅助用途**——`UNSUPPORTED_PURPOSE`：压缩与会话标题调用会为一件边角任务启动一次完整 agent 运行。
- **非 completed 结果**——`ENGINE_FAILURE`（显式取消则为 `ABORTED`），completed 但没有文本则为 `EMPTY_RESPONSE`。

每条路由公布**真实的模型目录**（`claude-code`：Claude Opus／Sonnet／Haiku 家族；`codex`：已安装 app-server 的 GPT-5.3 Codex 模型），外加一个 `native` 选项，意为「用 CLI 自己配置的默认——不发送任何覆盖」。选择目录里的模型会把 id 发给引擎（SDK `model`／app-server `turn/start model`）。目录里的每个模型都公布可选的**推理努力级别**（`off`／`low`／`medium`／`high`，Claude 另有 `xhigh`／`max`），映射到引擎原生词汇（SDK `effort`／`thinking`、app-server `effort`）；调用方省略时 harness 会物化 `high`。

## 组合

`@deepseek-ai/dsh-multi-provider` 组合包会连同两个后端一起挂载本适配器；可运行参考是 [`examples/multi-provider`](../../../examples/multi-provider/README.zh.md)。profile 需要 `dsh-subagent`（在 `dsh-base` 里）加上下面两个后端行与本行：

```yaml
- id: llm-engine
  name: '@deepseek-ai/dsh-llm-engine'

- id: subagent-codex
  name: '@deepseek-ai/dsh-subagent-codex'

- id: subagent-claude-code
  name: '@deepseek-ai/dsh-subagent-claude-code'
```

不需要密钥：只要 `claude` 已登录 claude.ai 和／或 `codex` 已登录 ChatGPT。

## 权限决策

引擎的原生权限流程在其进程内生效（Claude Code 的审批、Codex 的 `approval_policy`）；不涉及 harness 的审批 seam。详见各后端 README 的权限姿态。

## 模型体验

### 提示词文本

#### 模型看到什么

引擎只收到最新一条用户消息的文本（`stream()` 把它作为一次全新运行里的单个任务转发，即 Claude Agent SDK 的 `prompt` 或 app-server 的 `turn/start` 输入）。它看不到对话历史、harness 系统提示词或工具 schema；它自己的原生系统提示词、工具与权限在其进程内生效。

#### Token 影响

与数据相关；每次引擎运行支付一个独立的上下文，除记录下来的回答外不进入 harness 的派生历史。

#### KV Cache 影响

无；每次运行都是全新的引擎进程，使用自己的 provider 状态。

## 已知限制与暂缓事项

- **纯文本回合**——引擎的工具活动留在引擎进程内；会话日志不会为引擎回合记录工具调用（文本增量会实时到达，工具事件不会）。
- **续会话为可选项且写原生状态**——`continuation: true` 会把 Claude 会话文件与 Codex 线程持久化到原生 CLI 配置目录；默认的一次性姿态不触碰任何原生状态。
- **宿主 cwd**——引擎运行发生在宿主进程的 cwd，而不是会话的工作区。
- **拒绝辅助调用**——引擎会话的压缩与会话标题生成会失败；标题回退到 fallback 规则。
- **目录是静态的**——模型列表取自已安装 SDK／目录版本的精挑集合；更新的 CLI 可能支持列表里还没有的模型（`native` 选项始终跟随 CLI 自己的默认）。
