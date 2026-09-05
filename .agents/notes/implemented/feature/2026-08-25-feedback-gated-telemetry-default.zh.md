# Agent Note: 反馈门控的会话遥测默认值

Status: implemented

[English](2026-08-25-feedback-gated-telemetry-default.md) | 中文

## 问题

诊断一条 `/feedback` 报告需要报告所描述的会话数据。共享基础配置把未设置的 `DSH_TELEMETRY_MODE` 解析为 `DISABLED`，因此默认安装发出的反馈到达接收方时不带任何会话数据，报告者在求助的那一刻也没有授权共享的途径；只有事先导出了 `DSH_TELEMETRY_MODE` 的部署才能交付可诊断的报告。

## 决定

[权威反馈决策](../architecture/2026-09-05-canonical-feedback-log.zh.md)取代此默认组合：随附基础配置禁用 OTel 配置行。可选后端保留其模式；下述释放边界的理由不构成默认安装的上传授权。

共享基础配置的 OTel 行被显式启用且其 config 未被替换时，会把未设置或为空的 `DSH_TELEMETRY_MODE` 解析为 `FEEDBACK_ONLY`。插件自身省略 `mode` 的默认值仍是 `DISABLED`；`FULL` 和 `DISABLED` 是显式环境覆盖值，非空 `DSH_TELEMETRY_DISABLED` 仍是加载前的强制关闭开关。在 `FEEDBACK_ONLY` 下，每个 `feedback/record` 会释放同一 Session 对象的 handoff 游标之后至该事件的权威后缀。新对象从 constructor boundary 开始：全新 Session 从 seq 0 开始，而 fork、resume 或迁移 Session 排除 constructor seed，从本生命周期的 `session/end-seed` 开始。

反馈门控释放让报告者无需复现问题就能共享出问题的生命周期。它用显式反馈触发取代持续导出，但部署必须在启用该策略前取得同意。[已归档默认关闭](../../archived/feature/2026-08-10-telemetry-default-off.md)与[默认挂载](../../archived/feature/2026-07-31-web-telemetry-default-mount.md)记录记载早期组合；当前配置由[基础补丁](../../../../packages/bundle/base/cordis.patch.yml)与 [OTel README](../../../../packages/session/session-telemetry-otel/README.zh.md) 持有。

## 考虑过的替代方案

**要求报告者启用遥测后重跑。** 不作为反馈门控工作流：值得保留的证据是出问题的那个 Session，重跑会丢掉它。

**默认 `FULL`。** 否决：全新安装不授权没有用户动作的持续导出。

**仅通过后续 DeepSeek 请求投递。** 权威反馈决策为随附默认配置接受此方案，包括最后一条反馈可能留在本地的风险。可选反馈门控 OTel 模式保留事件发生时的释放触发；请求时投递若不发起另一个请求，就无法提供这种时机。

## 后果

- 随附基础配置不通过 OTel 上传任何内容。显式启用的 `FEEDBACK_ONLY` 后端只在 `feedback/record` 时交接未释放的生命周期本地前缀；消息评分事件本身不触发释放。
- 按需捕获在反馈时复制权威日志并脱敏。部署未挂载脱敏规则时，导出数据可能包含消息文本、工具参数和结果，以及 workspace 路径。
- 命令确认文本确认记录，而非共享或投递。要求事先知情同意的部署必须在启用上传前提供该步骤；OTel 交接仍受 SDK 的批处理、重试与丢失策略约束。
