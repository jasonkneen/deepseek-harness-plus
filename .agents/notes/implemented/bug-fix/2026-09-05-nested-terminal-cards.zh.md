# Agent Note: 嵌套 terminal 卡片

Status: implemented

[English](2026-09-05-nested-terminal-cards.md) | 中文

## 问题

经 `run_code` 分发的 shell 命令携带 terminal 卡片所需的参数与渲染输出，但对所有带有 `parentCallId` 的块一律拒绝，会仅因调用嵌套而隐藏这类展示。该拒绝也影响运行中的命令提示行与选中子调用的 Details。

## 决策

`terminalCardModel` 对根调用与 Code Dispatch 调用应用相同的适用检查，不因 `parentCallId` 拒绝调用。受支持的运行中与已完成的 `bash`、`pwsh` 和 `terminal_send` 调用使用现有 terminal 卡片。后台调用、工具错误、格式错误的输入、缺失的调用头和不受支持的结果内容保留通用回退。持久 shell 在运行中仍可使用 terminal，完成后使用通用展示；非零进程退出仍是 terminal 结果数据，而非工具错误。

本文仅部分取代 [Client 派生工具展示](../architecture/2026-08-23-client-derived-tool-presentation.zh.md)中的 terminal 子调用卡片禁令。该文继续负责 Client 展示所有权及 diff/read/search/web 子调用限制。无需更改 Host 展示转换器、事件、schema、元数据、调用树或模型上下文。[规范工具输出](../architecture/2026-07-20-canonical-tool-output-contract.zh.md)与 [PTC 类型化返回值](../feature/2026-07-20-ptc-typed-tool-returns.zh.md)中的元数据和执行期值决策保持不变；省略元数据不禁止 Client 派生 terminal 卡片。

以已识别的 spill 策略提示结尾的 shell 输出使用通用展示：在 `BashRow` 中可展开，在 Details 中使用原始回退。提示可能位于退出标记之后或取代它，因此末尾缺少退出标记不能作为 terminal 成功状态的依据。Client 识别最终提示，不更改 Host 输出或 schema。

## 考虑过的替代方案

**保留对嵌套调用的一律拒绝。** 不予采用，因为嵌套不会移除 terminal model 已消费的原始事实。这会隐藏可用的 shell 输出，而同一调用位于根时却可渲染为 terminal。

**启用所有嵌套结构化卡片。** 不予采用，因为其他 card model 有独立的元数据要求与子调用限制。本修复只改变 terminal 适用性。

**解析 spill 后缀附近的退出标记。** 不予采用，因为截断可能移除真实状态；保守的通用输出避免从不完整结果猜测成功。

## 后果

行与 Details 对嵌套调用共享 terminal 派生，不增加第二个渲染器或展示提示字段。通用回退与已完成持久 shell 的行为仍独立于 terminal 卡片适用性。父子关系仍控制树中的位置，而非 terminal 渲染。

## 验证

[Terminal 卡片测试](../../../../packages/client/ui-tool/tests/terminal-card.client.spec.tsx)覆盖根／子调用适用性、运行中与已完成的 Details 以及回退情况。[组装后的 Code Dispatch 测试](../../../../packages/client/ui-tool/tests/chat-code-subcalls.client.spec.tsx)覆盖经对话树渲染的嵌套 terminal。浏览器回放负责验证可见的嵌套卡片变化；非 terminal 子调用行为不属于本修复。
