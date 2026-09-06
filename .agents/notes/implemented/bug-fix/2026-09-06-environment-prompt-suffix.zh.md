# Agent Note: 环境事实位于可复用提示词指令之后

Status: implemented

[English](2026-09-06-environment-prompt-suffix.md) | 中文

## 问题

本地 Web URL、Harness checkout 路径和 persona 中的模型／工作区值因用户与机器而异。将这些事实放在可复用工具指令之前，会使其余内容相同的提示词在开头附近就出现差异，限制可供缓存复用的前缀。

## 决策

[系统提示词注册表](../../../../packages/core/system-prompt/README.zh.md)将固定 Harness 身份保留在最前，并把截至 `STRUCTURED_OUTPUT` 的第一方可复用指令放在环境信息后缀之前：`HARNESS_SOURCE` 位于 `10000`，`WEB_SURFACE` 位于 `10100`，`DEPLOYMENT_PERSONA` 位于 `10200`。既有段落名称、插值、作用域遮蔽以及精确的 `complete: true` persona 覆盖保持不变。顺序调整作用于完整段落；它不解析 persona 行文，也不添加 OS 变量或值。

本决策仅取代[提示词变量与工具指导归属记录](../architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.zh.md)中的 persona 位置。该记录保持有效，因为它的单一归属规则、严格插值和工具指导职责仍然适用。

## 曾考虑的替代方案

**仅移动源码路径与 Web URL。** 交付的 persona 还包含模型和 cwd；若 persona 仍靠近开头，不同工作区之间的可复用前缀仍会被打断。

**通过新 API 拆分环境事实，或从文本推断变量段落。** 既有具名段落顺序已覆盖当前提供方。新的分类或 persona 解析器会增加行为与配置，却没有当前消费方需要它。

**将这些事实移到 runtime-context 消息。** 这会改变其消息角色和持久化位置，而不只是顺序。既有系统段落可以在保留内容与归属的同时移到可复用指令之后。

## 后果

跨用户字节相同的前缀要求工具、配置和前置段落文本一致。工具 schema、plan mode、部署专用指导和实验性 Team 状态仍可能不同。任意扩展顺序与组装监听器仍决定最终结果；这是一项第一方位置策略，而非通用稳定前缀保证。不测量或承诺提供方共享缓存及命中率提升。

部署 persona 和 Web／源码指导出现得更晚，包括位于结构化输出指令之后。结构化输出无需成为最后一个字符串；完整 persona 覆盖仍会抑制其他所有系统段落。源码与 Web 事实保留 Harness checkout、会话工作区和当前工作目录之间的既有区分。

## 测试

[注册表测试](../../../../packages/core/system-prompt/tests/system-prompt.spec.ts)在 checkout 路径、URL、模型、cwd 值和测试注册的平台变量变化时比较相同的可复用前缀；同时覆盖严格插值与完整覆盖。[循环测试](../../../../packages/core/agent-loop/tests/loop.spec.ts)固定请求顺序和会话 cwd 插值。[Persona 测试](../../../../packages/preset/persona/tests/persona.spec.ts)覆盖作用域替换与完整 persona。[录制的提示词快照](../../../../docs/testing.zh.md)覆盖原生工具与生成 SDK 组合发出的提示词；它们不测量提供方缓存命中。
