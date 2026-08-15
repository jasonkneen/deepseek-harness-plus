# Agent Note: 多 provider 包与整会话引擎

Status: implemented

[English](2026-08-14-multi-provider-pack-and-engines.md) | 中文

## Problem

部署方希望接入第三方模型 provider 与外部编码 agent，且各自有不同的凭据方式。通用 pi-ai 适配器（`dsh-llm-pi-ai`）已经内置 Gemini（`google`）、MiniMax（`minimax`）与 Kimi（`kimi-coding`）的目录，但在 `dsh-base` 中处于休眠挂载——激活它们是 settings 文档层面的操作，而不是可随发行版交付的层。Claude Code（官方 Agent SDK）与 Codex（官方 `codex app-server`）委派后端已作为包存在，但未出现在任何随发行版组合中，也没有任何文档描述或运行「整个会话跑在某个引擎上」。问题是：第三方支持到底需要新适配器、替换 agent loop，还是纯组合方案。

## Decision

**组合包，而不是新适配器。** `@deepseek-ai/dsh-multi-provider`（`packages/bundle/multi-provider`）是叠在 `dsh-base` 之上的可选 profile 层。它的 patch 激活四条 pi-ai 路由，带精选模型目录与凭据引用（`GOOGLE_API_KEY`、`MINIMAX_API_KEY`、`KIMI_CODING_API_KEY`、`ANTHROPIC_API_KEY`——最后一条是基于密钥的 Claude API），并插入 `subagent-codex`／`subagent-claude-code` 配置行及其面向模型的工具行（`subagent_codex`、`subagent_claude_code`），工具行 `disabled: true`——即随发行版 profile 的姿态：provider 在宿主上加载，直到工具调用才启动子进程，默认不向任何组合出来的 agent 增加委派工具。可运行参考组合是 `examples/multi-provider`，其 `llm-pi-ai` providers 字典与 pack patch 完全一致；`examples/multi-provider/tests/providers.spec.ts` 用测试机制保证两者同步。演示 bin（`packages/examples/multi-provider-demo`）可无密钥列出 provider，为基于密钥的 provider 各跑一次任务，并把 `run --provider claude-code|codex` 路由到委派后端（原生 OAuth，无密钥）；基于密钥的回合失败时会报告持久化的 `turn/end` 错误（例如指明缺哪个密钥的 `MISSING_CREDENTIAL`），而不是笼统的「空回复」。带密钥套件在原生 OAuth 下对每个基于密钥的 provider 跑一次真实回合、对每个后端跑一次真实委派，其中包含经由演示 bin 引擎路由的用例。

**引擎作为可选的 LLM provider 经由适配器 seam 接入，而不是 loop 改动。** `@deepseek-ai/dsh-llm-engine` 继承 `LlmAdapter` 并在 `ctx.llm` 上注册 `claude-code` 与 `codex` 两条 provider 路由（模型 id 为 `native`），由同样的 `ctx.subagents` 后端支撑：模型选择指向这些路由之一的会话，每一回合都会通过本地 CLI 以其 OAuth 状态运行——web Models 选择器会像列出其他 provider 一样列出它们。每次 `stream()` 发送最新一条**直接**用户提示词（合成上下文注入按 source kind 排除），把引擎的实时文本增量作为 `text-delta` 块转发，用组装好的回答加终止 finish 收尾，固定零重试策略（重试等于把 CLI 执行两遍），并以 error finish 拒绝空提示词与辅助用途（压缩、会话标题）。从 harness 的视角看，引擎始终是纯文本：它们在自己的进程内执行自己的工具。

**长会话引擎，而不是每次重来。** 引擎原生支持长会话与流式——Claude Agent SDK 的 `persistSession`／`resume` 与 `stream_event` 文本增量，Codex 的 `thread/start`／`thread/resume` 与 `item/agentMessage/delta` 通知（已对照安装的 SDK 类型与生成的 0.147.0 app-server schema 验证）。subagent seam 增加了可选的 `continuation` 能力、`continueFrom`／`continuationId` 请求／结果字段，以及 `SubagentRun` 上的实时 `updates` 通道；两个引擎后端都在 `continuation: true` 配置后实现了它们（写入原生状态是刻意选择——默认的一次性姿态仍不触碰任何原生状态）。适配器按 loop 盖戳的 `GenerateOptions.sessionId` 为引擎会话建索引并在后续回合恢复；memory e2e 证明引擎第 2 回合是从它**恢复的对话**里作答的。

**整会话引擎是实验性 runner，而不是 loop 改动。** `examples/engine-session` 不组合任何 harness agent loop：`packages/examples/engine-session-demo` 创建 harness 会话，追加 `turn/start` 与 `user/message`，通过既有的 `claude-code` 或 `codex` subagent provider（原生 claude.ai／ChatGPT OAuth，无需密钥）委派整个任务，把引擎的最终回答作为 `assistant/message`、把结果作为 `turn/end` 追加（surface 事件携带 `surfaceOp: 'append'`），把会话 flush 到 JSONL 持久化，然后打印回答。harness 拥有持久对话记录；引擎在运行内部拥有自己的 loop、工具与权限。两个引擎都已通过真实组合实测，e2e 断言的是持久化下来的对话记录，而不是引擎的自述。

## Alternatives considered

**按 provider 写独立适配器插件（Gemini／MiniMax／Kimi）。** 已拒绝：pi-ai 维护着端点／协议／模型目录这一整套表面（`google-generative-ai`、`anthropic-messages`、`openai-completions`），手写适配器会在违反依赖策略的同时重复维护已有代码与测试。纯配置激活让 pack 保持为一份 patch 列表。

**把引擎当作 `LlmAdapter` 路由（主 loop provider）。** 已拒绝：Agent SDK 与 app-server 是完整的 agent，会执行自己的工具 loop；harness 的 `llm/stream` 消费方无法在不绕过 harness 工具执行、沙盒与会话日志不变量的前提下把它们的回合行为翻译成 `StreamChunk`。委派 seam（`ctx.subagents`）才是诚实的集成点，engine-session runner 是建立在它之上的整会话形态。

**engine 会话复用 multi-provider leaf。** 已拒绝（组合清晰度）：engine leaf 只挂载 subprocess、subagent、两个后端、会话存储与持久化——没有 agent spine、没有适配器——于是「没有 harness loop」是结构事实，而不是顺带的巧合。

## Consequences

基于密钥的第三方 provider 以配置形式落在被维护的适配器上（现在包含基于密钥的 Claude API 路由）；pack 用测试保证 leaf 与 bundle patch 同步。为把引擎接入演示 bin，抽取了两处共享的「最终回答」聚合：`textOfBlocks(content)`（`dsh-llm`）拼接文本块，`lastAssistantText(events, fromSeq)`（`dsh-session`）是「会话最终回答」的唯一定义，headless runner 与所有演示驱动都使用它。引擎适配器让本地 OAuth CLI 成为任何组合了它的 profile（包括 web 应用）里的一等 provider：选择 Claude Code 或 Codex 会把会话的回合路由到本地 CLI，代价是引擎回合没有跨回合记忆、会话日志不出现工具调用、运行发生在宿主 cwd，且辅助调用被拒绝。Claude Code 与 Codex 通过经过测试的 subagent seam 以原生 OAuth 集成；实验性整会话模式为外部引擎的运行记录可持久、可回放的 harness 对话记录。代价：后端工具行默认禁用（启用会改变每个 agent 的工具面；用 Agent Preset 限定范围）；整会话运行是一次委派——多轮续聊、流式进度与实时工具回显均未实现；推理与中间工具活动留在产品本地；pack README 说明：删除某路由的 `models` 列表即改为提供完整已安装目录，后续 patch 若要扩展 providers 字典必须重述全部路由（patch 会替换整行 config）。
