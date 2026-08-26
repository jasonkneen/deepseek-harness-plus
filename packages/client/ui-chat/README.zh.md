---
description: "渲染 Session 对话节点、详情、历史图片、操作、本地化和滚动状态的浏览器 Chat target。"
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-chat

[English](README.md) | 中文

## 概述

Conversation 组装的浏览器 Chat target。本包注册 Chat event definition 与 snapshot 构造、提供 `useChat`、渲染 transcript node 和详情，并拥有 Chat 专属 store、action、本地化与滚动位置恢复；历史图片 URL 通过 Conversation 持有的按会话缓存（`ctx.uiConversation.imageUrl`）解析。其中 Assistant 与 Turn Tail definition 会直接 fold packed Assistant 历史 run，不展开其成员。

## 目录

- [系统提示词行](#system-prompt-row)
- [轮次 token 用量](#turn-token-usage)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="system-prompt-row"></a>
## 系统提示词行

Chat 会为每个非空的初始或恢复请求、显式消息序列起点或真实 system 字段变化显示一行默认折叠的`系统提示词`。同一序列内仅配置或仅工具变化、工具步骤与重试不会重复该行。该行位于请求的用户消息之前，与提供方 envelope 顺序一致；展开后显示保留原始换行的精确模型可见文本。历史窗口不完整时，非初始 header 会保守显示，直到前一页到达；没有系统提示词的 header 不创建该行。

-----

<a id="turn-token-usage"></a>
## 轮次 token 用量

只有当已加载窗口包含 `turn/start`，且每次已启动的模型尝试都报告安全、精确的用量时，已完成 Turn 才显示可展开的用量行。该行会省略不可用的可选用量桶。记账不完整或相互矛盾时，整个详情都不显示，避免把部分总量冒充完整结果。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包在浏览器中渲染已记录的对话状态，不注册任何面向模型的内容。

#### KV Cache 影响

无；Chat 呈现不会组装或修改提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **视图只反映已加载的 Session 窗口**——只有 Session Controller 加载前一页 event 后，更早的 transcript node 才会出现。轮次导航同样只表示已加载的 Turn；加载更早一页时，已有 Turn 刻度保持身份不变，完整的已加载集合在紧凑轨道中重新排布，不显示未加载历史占位。刻度默认相隔 10px，仅在已加载集合超过可用高度时压缩间距。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
