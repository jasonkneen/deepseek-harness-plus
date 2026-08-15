# engine-session 示例

[English](README.md) | 中文

实验性整会话模式的可运行演示：**不组合** harness agent loop；整个会话通过一个委派引擎运行——[官方 Claude Agent SDK 驱动的 Claude Code](../../packages/subagent/subagent-claude-code/README.md)（`claude-code`）或[官方 `codex app-server` 驱动的 Codex](../../packages/subagent/subagent-codex/README.md)（`codex`）——而 harness 拥有持久会话。位于 `packages/examples/engine-session-demo/src/bin.ts` 的引擎 bin 创建会话、记录用户提示词、委派整个任务、把引擎的最终回答与回合结果作为普通会话事件记录，并把会话 flush 到 JSONL 持久化。

这是 [`@deepseek-ai/dsh-multi-provider`](../../packages/bundle/multi-provider/README.md) pack 文档中记录的实验性路径：同样的后端原本每次只回答一次委派，现在可以回答整个会话，且对话记录保留在 harness 自己的会话日志中。它不是 harness agent loop——这里不运行工具执行、沙箱、审批或模型路由；运行内部由引擎自己的 loop 说了算。

## 运行

```sh
# The whole session runs on Claude Code (native claude.ai OAuth):
pnpm run demo:engine-session claude-code "fix the failing test in this repo"

# The whole session runs on Codex (native ChatGPT OAuth):
pnpm run demo:engine-session codex "summarize the git log"
```

两个引擎都用各自的原生 OAuth 状态认证——不需要 API 密钥。会话对话记录持久化在本 leaf 的 `.sessions/` 下（zstd JSONL，与所有其他 harness 会话一致）。

## 测试

| 套件 | 密钥 | 固定什么 |
|---|---|---|
| `tests/engine.spec.ts` | 无 | 真实 Loader 启动：两个引擎都已注册，会话可创建，完整对话记录序列（turn/start → user/message → assistant/message → turn/end）在没有任何后端运行的情况下追加并 flush |
| `tests/engine.e2e.ts` | 无（原生 OAuth） | 通过真实 bin 对每个引擎跑一个完整会话：stdout 回答 PONG，且持久化的 `.sessions` JSONL 包含用户提示词、引擎回答与 `completed` 回合结束；产品 CLI 缺失或未登录时自行跳过 |

## 已知限制（实验性）

- **每次会话一次委派**——会话只被一个用户提示词驱动一次；多轮续聊、流式进度与实时工具回显均未实现。
- **没有 harness loop 服务**——工具、沙箱、审批、压缩与模型路由都不运行；引擎自己的 loop、工具与权限说了算。
- **只记录最终文本**——只有引擎的最终回答被记录；推理与中间工具活动留在产品本地。
- leaf 的配置行是引擎所需的最小集合；当会话需要同时使用引擎与 harness provider 时，请从 multi-provider leaf 组合开始扩展。
