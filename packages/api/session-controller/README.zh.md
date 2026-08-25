# Session Controller

[English](README.md) | 中文

`@deepseek-ai/dsh-api-session-controller` 拥有 Host 的 `ctx.sessionController` 服务和生成的 Client `ctx.remote.session` namespace。它提供 Session 列表、搜索、创建、模型选择、重命名、fork、prompt、附件、queue、取消、按消息对齐的历史、live 日志跟随和 Host 范围 control 状态。

历史页与 follow event frame 只携带原始 `SessionWireEvent`。工具参数、结果内容、失败信息和 `tool/result.data.meta` 原样通过；controller 不解析 Tool definition、不运行 presenter，也不附加 UI 数据。

每个 endpoint 都声明自己的激活策略。列表、搜索、附件、历史页和日志跟随可以在不激活 Agent 的情况下检查 persistence；queue 变更和取消要求对应 live 状态仍然存在；模型、重命名和 prompt 命令可以显式恢复普通 Session。只有 create 和 fork 会创建新 Agent。该服务把同一套感知 preset 的恢复策略和 subagent ownership fence 同时用于自身方法，以及其他 Remote namespace 使用的 Typert Agent 与 Session lookup。

Client adapter 提供 `SessionEventStream`，即绑定到一个普通 Session 或 direct subagent address 的 Gateway `RemoteJournalStream`。它在读取首个 page 前打开 follow，只发布连续的 `replace`、`prepend` 和 `append` 变更，并通过 tail page 修复重连或 seq 缺口。业务、persistence 或无法恢复的连续性错误会终止 stream，只有物理载体断开才触发自动恢复。`SessionControlStream` 是 Gateway `RemoteSnapshotStream`；每代都以完整的进程本地 baseline 开始，因此重连会替换 queue、jobs 和 projection 状态，而不会把瞬态值当作 durable event。

## 模型体验

无，因为被调用的 Agent 命令拥有任何模型可见效果。

#### KV Cache 影响

无直接影响；模型请求仍由 Agent 和 LLM 包拥有。

## 已知限制与延期工作

- Control baseline 表示进程本地状态，因此 Host 重启后无法重建 jobs。
- follow 恢复失败会对调用方可见，而不会无限重试。
