---
description: "Host 与 Client 会话控制：创建、恢复、提示、跟随历史并投影实时会话状态。"
kind: "package-reference"
---
# Session Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-session-controller` 拥有 Host 的 `ctx.sessionController` 服务和生成的 Client `ctx.remote.session` namespace。它提供 Session 列表、搜索、创建、模型选择、重命名、fork、prompt、附件、queue、取消、按消息对齐的历史、live 日志跟随和 Host 范围 control 状态。当 Client 需要这些 Session 操作时，请通过 API Gateway 使用它。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

历史页与 follow opening snapshot 携带带判别字段的 `SessionHistoryRecord`。两个分支都使用 `{ type, event }`：`type: 'event'` 携带一个原始 `SessionWireEvent`，`type: 'chunks'` 则携带一个由连续且属于同一 block 的 `assistant/chunk` delta 组成的无损 `ChunkRowEvent`。两种内部值都公开 `type`、`seq`、`time` 与 `data`，因此 Client 无需逐 record 转换，就能把每条已接受 record 保留为一个 `SessionEventLikeEntry`。packed event 的 `seq` 与 `time` 表示首成员，`data` 保留 fragment 与 timestamp-gap 数组。实时 follow frame 继续携带单个 `event` record。工具参数、结果内容、失败信息和 `tool/result.data.meta` 原样通过；controller 不解析 Tool definition、不运行 presenter，也不附加 UI 数据。

每个 endpoint 都声明自己的激活策略。列表、搜索、附件、历史页和日志跟随可以在不激活 Agent 的情况下检查 persistence；queue 变更和取消要求对应 live 状态仍然存在；模型、重命名和 prompt 命令可以显式恢复普通 Session。只有 create 和 fork 会创建新 Agent。该服务把同一套感知 preset 的恢复策略和 subagent ownership fence 同时用于自身方法，以及其他 Remote namespace 使用的 Typert Agent 与 Session lookup。

Client adapter 提供 `SessionEventStream`，即绑定到一个普通 Session 或 direct subagent address 的 Gateway `RemoteJournalStream`。它在读取首个 page 前打开 follow，只发布连续的 `replace`、`prepend` 和 `append` 变更，并通过 tail page 修复重连或 seq 缺口。普通 record 覆盖 `[event.seq, event.seq]`，packed row 覆盖 `[event.seq, event.seq + memberCount - 1]`。业务、persistence 或无法恢复的连续性错误会终止 stream，只有物理载体断开才触发自动恢复。`SessionControlStream` 是 Gateway `RemoteSnapshotStream`；每代都以完整的进程本地 baseline 开始，因此重连会替换 queue、jobs 和 projection 状态，而不会把瞬态值当作 durable event。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `coldBlankProbeMaxBytes` | `1,024` | 可进行空白状态验证的冷 Session 工件最大物理大小；`0` 禁用探测 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-session-controller)是所有受支持字段及其 JSDoc 的完整来源。

-----

<a id="model-experience"></a>
## 模型体验

无，因为被调用的 Agent 命令拥有任何模型可见效果。

#### KV Cache 影响

无直接影响；模型请求仍由 Agent 和 LLM 包拥有。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Control baseline 表示进程本地状态，因此 Host 重启后无法重建 jobs。
- follow 恢复失败会对调用方可见，而不会无限重试。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
