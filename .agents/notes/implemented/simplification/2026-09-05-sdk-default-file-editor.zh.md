# Agent Note: SDK 默认文件编辑器选择

Status: implemented

[English](2026-09-05-sdk-default-file-editor.md) | 中文

## Problem

标准 SDK profile 从共享 base 同时继承 `read`/`write`/`edit` 和 `str_replace_editor`。这些工具提供重叠的文件编辑接口，而 Web standard preset 选择前者。[Issue #3599](https://github.com/deepseek-harness/deepseek-harness/issues/3599) 要求标准 SDK 采用相同的编辑器选择，不要求 SDK 与 Web 的全部行为一致。

## Decision

[SDK 应用 patch](../../../../packages/bundle/sdk-app/cordis.patch.yml) 禁用继承的 `tool-str-replace-editor` 配置项。SDK 保留 `read`、`write` 和 `edit`；共享 base、可复用编辑器包及独立 `sdk-minimal` 组合保留各自的默认值。受信任的 profile、home 或逐次调用 patch 可以显式启用该配置项。

本决策收窄了[统一 dsh 启动器](../architecture/2026-08-22-single-dsh-application-launcher.zh.md)所述的 SDK 工具默认值。该决策对启动所有权、共享服务和 patch 优先级仍然有效；没有被完全取代的活跃 Agent Note。

## Alternatives considered

**继续默认启用两个编辑器。** 共享 base 组合解释了它们为何可用，但标准 SDK 无需为相同的文件编辑操作默认提供两套接口。需要此编辑器的调用方可以显式选择它。

**移除共享注册或复用整个 Web preset。** 两者都会扩大 SDK 默认值调整的范围。将改动放在 SDK bundle 中可以保留其他 profile 和现有应用架构。

## Consequences

默认 SDK 请求省略该编辑器 schema。按名称选择 `str_replace_editor` 的调用方需要显式 patch 或其现有专用组合。本决策不承诺 SDK/Web 的全部工具一致。

## Verification

[SDK profile 进程测试](../../../../apps/cli/tests/profiles/sdk/keyless-smoke.e2e.ts) 捕获默认工具清单、显式启用编辑器和独立极简工具清单的实际模型请求。[SDK 录制会话](../../../../snapshots/sdk/sdk.snapshot.ts) 固定最终 schema；跨 profile 共享录制与持久编辑器录制显式保留其所需的编辑器。
