# Agent Note: 进程外 subagent 公开最小可行动诊断

Status: implemented

[English](2026-08-21-out-of-process-subagent-minimal-diagnostics.md) | 中文

## Problem

ACP 子进程可能因为达到远端限制、拒绝必需权限、失去协议传输或进程退出而停止。共享结果以往只把这些结果压成 `error` 等结束原因，而启动和清理拒绝的消息还可能暴露原始异常。父 agent 若不读取 Host 日志，就无法决定应缩小任务、调整权限策略还是修复子运行时部署。

若把异常、stderr、任务内容、工具输入、路径、环境值、凭证或协议 payload 复制进 `SubagentResult.diagnostic`，不受信任的子进程文本就会变成模型可见内容。若复用完整的产品专属错误联合，又会在提供方无关的 [subagent seam](2026-06-21-subagent-capability-seam.zh.md) 中复制彼此独立版本化的权威。

## Decision

每个进程外提供方分别拥有一份小型映射，把其协议与进程生命周期位置已经收到的事实转换成固定安全展示文本。ACP 提供方使用闭集结束原因、当前操作、闭集工具种类、已配置权限策略、选中的权限结果，以及受管子进程退出码或信号来实现该规则。消费方继续使用现有可选 `SubagentResult.diagnostic`，且不解析其标点或提供方私有 category 名称。

### 安全失败文本

通用 error 诊断采用以下固定字段顺序：

```text
Subagent failure (provider: <provider>; stage: <stage>; category: <category>; stop reason: <reason>; exit code: <code>; signal: <signal>)
```

不可用的可选字段会被省略。共享结算边界会把完整结果限制在 4096 个 UTF-8 字节以内。成功结果和本地取消不携带失败诊断。部分 assistant 输出继续保留在 `SubagentResult.output` 中，并与诊断分开呈现。

当 ACP 权限请求参与非完成结果时，一个固定行会记录 `policy`、ACP 闭集工具 `request` 种类和 `decision`。工具标题、raw input、位置、选项名称与 metadata 均被排除。对于 `max-tokens`、`refusal` 或远端 `aborted`，公共结束原因已经携带终态事实，因此权限行就是完整诊断；通用 error 路径则把它附在失败行之后。带诊断的远端 `aborted` 结果仍保持公共结束原因；一次性 Job adapter 会把它判为 failed，而不带诊断的本地取消仍是 killed。

### ACP 事实

| Stage | 归属操作 | 安全 category 与事实 |
| --- | --- | --- |
| `initialize` | 父工作区解析与 ACP initialize | `configuration`、`transport` 或 `process-exit` |
| `new-session` | ACP `session/new` 与返回 session id 校验 | `protocol`、`transport` 或 `process-exit` |
| `prompt` | ACP prompt 请求、远端结束原因与权限回调 | `remote-limit`、`transport`、`unknown` 或仅权限诊断 |
| `process` | 子进程 spawn 失败，或受管子进程先于 prompt 终态响应退出 | `process-start`，或 `process-exit` 以及分别观测到的退出码与信号 |
| `teardown` | EOF 停稳与受管进程树终止 | 固定 teardown 事实；原始清理失败仍留在内部 |

`max_turn_requests` 继续映射到共享 `error`，并附加 `remote-limit`。未知结束原因继续映射到 `error`，category 固定为 `unknown`，不会复制原值。`max_tokens`、`refusal` 与 `cancelled` 保持既有共享结束原因；只有需要解释权限决定时才会附加诊断。

### 所有权与生命周期

| 事实或资源 | Owner | 消费方行为 |
| --- | --- | --- |
| ACP 结束原因与工具种类 | ACP server 与 SDK | 提供方只映射闭集值，并对闭集外值使用固定 unknown 回退 |
| 当前失败 stage 与最新权限决定 | 单次 ACP 运行 | 只在失败点派生，并随运行丢弃；并发运行不共享诊断状态 |
| 退出码与信号 | `dsh-subprocess` 句柄 | 仅在观测到受管结果后展示；绝不解析 stderr |
| 诊断字节与呈现 | `dsh-subagent`、前台工具与 Job 运行时 | 前台和一次性后台模式都把同一份有界文本与 assistant 输出分开 |
| 原始失败 | 子运行时、Error cause 链与 Host logger | 只供 Host 排障，绝不复制进父模型结果 |

启动只有在 initialize 与 new-session 成功后才发布运行。启动失败会先把私有子进程回滚到完全停稳，再以安全事实拒绝。已发布运行的结果不会拒绝，而 `dispose()` 会独立报告安全 teardown 失败，并继续使用后端既有的整棵进程树清理阶梯。

## Verification

ACP 包测试通过真实 stdio 协议子进程固定全部结束原因映射、远端限制与 unknown 回退、权限 allow/deny 事实、configuration、initialize、new-session、prompt、process 与 teardown stage、启动回滚、成功结果与本地取消省略、部分输出、并发运行隔离、仅 Host 可见的原始错误、进程完全停稳，以及共享多字节诊断限制。Loader 组合证明真实配置的提供方会到达模型可见前台结果。无密钥 ACP snapshot 会在前台错误输出与一次性后台 `job_output` detail 中固定同一份诊断与权限事实。

## Alternatives considered

**返回原始异常、stderr 或协议 payload。** 这些值可能包含任务内容、工具输入、路径、环境值、凭证和上游文本。固定白名单事实能够保留可行动差异，而不扩大模型可见信任边界。

**增加共享结构化错误 enum。** ACP 与其他进程外提供方拥有不同生命周期位置和闭集终止词汇。共享 enum 会制造虚假的统一，并迫使无关消费方跟随提供方版本。

**解析异常消息或 stderr 来分类。** 自由文本既不稳定也不安全。只有闭集协议值、typed 错误、当前调用位置与受管进程结果可以成为诊断输入。

**修改既有结束原因。** 结束原因继续表示提供方无关的终态结果。可选诊断说明非完成结果为何要求不同的下一步，而不增加新的公共结果状态。

**增加重试、恢复状态或交互审批。** 诊断只负责报告失败，不拥有修复动作。重试策略、会话恢复与人工交互需要独立用户约定和生命周期责任方。

## Consequences

父 agent 可以区分 ACP 远端限制、权限参与、协议或传输失败、部署/进程失败与 teardown 失败，同时不会接收子进程控制的文本。启动和清理错误与已发布结果使用同一套安全事实，而 Host 观测仍保留原始 cause。

诊断仍是展示文本，不是公共协议。消费方可以呈现它，但不得按格式分支。本决策不增加重试策略、恢复控制器、共享提供方错误 enum、stderr 分类器、认证分类、会话持久化、进度流或新的 ACP 能力。
