# Agent Note: 同会话用户消息编辑

Status: implemented

[English](2026-09-01-same-session-user-message-edit.md) | 中文

## 问题

即使用户希望留在同一个 Session 中继续工作，修正已发送消息也必须创建 fork。[此前移除无后端 Edit 控件的决策](../../archived/simplification/2026-07-31-drop-user-message-edit-stub.md)正确地在 Host 操作存在前隐藏了这项可供性。仅复用模型 surface 替换并不够：压缩有意只从模型上下文移除旧消息，而 Edit 还必须替换 Chat、Trajectory、轮次导航、标题输入和搜索中的可见对话代次，同时不能删除审计数据。运行中的轮次、已排队提示词、附件和会话引用上下文也使同会话重跑不只是一次 UI 文本修改。

## 决策

普通 Session 的 `session.edit` 操作只接受最新的人工 `user/message`，且该消息必须用于开启轮次并仍位于当前模型 surface。请求标识目标事件，并携带编辑器打开时观测到的最近人工消息 seq。Host 会在任何中断前进行校验，并在持有 idle maintenance 时再次校验；后续人工消息会使请求变为 stale。更早的消息、direct subagent Session、steering 消息、已压缩消息和没有可编辑文本的消息都会被拒绝。

如果 Agent 正在运行，Edit 会用 `keepInbox: true` 取消活跃轮次，并在其进入 idle 时同步取得 maintenance。它把替换消息插到 `next-turn` 前端，因此编辑重跑先于已有 Queue 工作执行，但不会删除 Queue。持久 inbox 准入会携带替换消息的 `SurfaceIntent` 与所有保留的会话引用消息；AgentLoop 在编辑提示词之后立即展开这些配套消息，并通过 `MessageId` 让非默认放置方式穿过 `agent/pre-step` 重写。pre-step payload 会公开已领取的 intent，主动压缩在预定 surface 替换待提交时推迟，因此替换坐标在提交前保持有效。即使准入后发生重启，替换语义和引用顺序仍会保留。

替换消息保留目标消息的非文本内容，使用提交的新文本和新时间戳，并采用 Session 当前的模型选择。带图片的编辑会在中断活跃工作前验证该模型。已有会话引用 recall 消息会被复制而不重新生成，因此重跑使用原提示词引用的快照。Edit 不会回退文件、进程、后台任务、subagent 或任何其他外部副作用。

已提交的替换 `user/message` 携带两个独立操作。其 `surfaceOp` 替换从编辑轮次开始的当前模型消息后缀，`sourceEventSeqs` 列出每个被移除的 surface 节点；其 `conversationOp` 从当前用户可见投影中隐藏自该轮 `turn/start` 到准入前日志末尾的原始事件闭区间。所有旧事件仍保留在仅追加日志中。

`ui-conversation` 在每个 target 组装 node 前折叠 `conversationOp` 区间，并在替换到达时原子重建已加载窗口，因此 Chat 不会发布新旧代次混合的中间状态。轮次大纲会移除被隐藏的轮次。替换消息会取消待执行或正在运行的自动标题工作，但不会安排新的 revision；后续普通标题 revision 只读取当前对话代次。Session Query 把编辑隐藏区间内每个可搜索事件分类为 `shadowed`；面向模型的搜索默认只查询 `current` 与 `log-only`，且不公开 `shadowed`，精确读取与追踪仍可用于诊断。无损 Session 导出与全日志统计保留两代内容。

Chat 只在该最新且符合条件的消息上公开「编辑消息」。编辑使用铺满 Chat 内容列的 composer 风格输入卡片，带输入表面背景、边框、阴影和卡片内部的取消／保存操作行。文本框初始高度为 80px，随内容增长至 240px 后改为内部滚动。Enter 提交，Shift+Enter 插入换行，Escape 取消，普通 composer 保持可用。开始另一条提交会关闭编辑器。提交会立刻用本地回显替换选中后缀；失败恢复持久视图，成功则交接给替换事件。结果不显示已编辑标记，也没有 Undo，已有 Session 标题保持不变。

已交付范围是 [issue #2351](https://github.com/deepseek-harness/deepseek-harness/issues/2351) 的 Edit 部分。Fork 与 Rewind 仍是独立行为。

## 曾考虑的替代方案

**每次重跑前都创建 fork。** 被否决，因为它会改变 Session 身份，并迫使用户在修正与分支之间做选择。需要让两份历史都可独立导航时，fork 仍然有用。

**修改或删除原事件。** 被否决，因为 Session 持久化、回放、诊断与无损导出都依赖仅追加日志。替换事件记录新代次，同时保留先前事实。

**把每个 `SurfaceOp` 替换都视为人类 transcript 替换。** 被否决，因为压缩与结果裁剪有意改变模型上下文，却不抹掉用户已经看到的内容。`conversationOp` 是显式且独立的机制。

**复用待处理 Queue 编辑器。** 被否决，因为已排队消息尚未进入模型历史，而历史编辑必须替换已消费上下文、安全中断当前工作并重新运行。

**清空 Queue，或把它应用到编辑请求中。** 被否决，因为 Queue 条目仍是用户拥有的未来轮次。编辑轮次先运行，并留出用户继续删除排队工作的时间窗口。

**让 Undo 与 Edit 同时提供。** 被否决，因为在新模型输出出现后撤销需要再定义一套显式代次替换和冲突策略。保留的原始事件保存了数据，但不会宣告尚不受支持的反转操作。

## 后果

每次编辑都会增加一个新轮次，以及持久 inbox 与替换元数据；存储、无损导出和全日志统计都会随每一代内容增长。当前对话视图与默认模型搜索省略被替换代次，诊断读取仍可检查它们。

对每个事件进行对话区间成员判断的复杂度，与合并后编辑区间数量呈对数关系。SQLite 提供方本就会为变化后的实时 Session 重建文档；Edit 增加分类工作，但不引入第二份文本索引，也不需要删除并重插历史行。

首条被替换模型消息之前未变化的前缀仍可复用提供方 KV Cache。编辑后的后缀会开启新的请求序列，并正常产生请求与响应 token。

单元测试固定区间校验与折叠、持久 inbox 回放、pre-step intent 保留、Queue 优先级、中断、附件与引用保留、标题与大纲行为、搜索分类和乐观 UI 交接。Web replay e2e 通过真实 Host 与浏览器固定编辑、重跑、隐藏旧输出和刷新重建。
