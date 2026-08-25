# @deepseek-ai/dsh-client-ui-chat

[English](README.md) | 中文

Conversation 组装的浏览器 Chat target。本包注册 Chat event definition 与 snapshot 构造、提供 `useChat`、渲染 transcript node 和详情，并拥有 Chat 专属 store、action、本地化与滚动位置恢复；历史图片 URL 通过 Conversation 持有的按会话缓存（`ctx.uiConversation.imageUrl`）解析。其中 Assistant 与 Turn Tail definition 会直接 fold packed Assistant 历史 run，不展开其成员。

## 系统提示词行

Chat 会为非空的初始或恢复请求、显式序列起点，或 system 字段真实变化贡献一行 `系统提示词`；同一序列内仅配置变化或仅工具变化、工具 step 和重试不会重复该行。Chat 会把一个 step 中的首条 header 放在该请求的消息边界——step one 使用 turn start，其余 step 使用 step start——位于该请求发送的 user-role 消息之前，与提供方信封「system 在 messages 之前」的顺序一致；部分窗口未包含前序 header 时，非 initial header 会保留在自身 Event 并保守渲染，直到 prepend 补入前序 header。该行默认折叠，仅在展开期间把完整提示词挂到与不透明上下文注入相同的 141px 代码块内容区——保留模型所见真实换行的模型可见文本，而非 Markdown；它没有流式路径。无系统提示词的 header 不生成行。

## 模型体验

无，因为本包在浏览器中渲染已记录的对话状态，不注册任何面向模型的内容。

#### KV Cache 影响

无；Chat 呈现不会组装或修改提供方请求。

## 已知限制与暂缓事项

- **视图只反映已加载的 Session 窗口**——只有 Session Controller 加载前一页 event 后，更早的 transcript node 才会出现。
- **单轮次 token 用量采用 fail-closed 方式**——只有已加载窗口包含 `turn/start`，且每个已开始的模型 attempt 都具有安全、精确的用量时，已完成轮次才显示 disclosure。缺失的 bucket 会被省略，记账不完整或矛盾时则隐藏整条 disclosure。
