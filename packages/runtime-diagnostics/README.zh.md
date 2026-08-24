# runtime-diagnostics/：包自有运行时检查

[English](README.md) | 中文

可配置诊断用于检查包自有的运行时关系，而不改变产品行为。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`invariants/`](invariants/README.zh.md) | 注册并运行包自有的运行时不变式配套入口 | `ctx.invariants` |

有关选择、生命周期和归因到包的失败语义，参见[运行时不变式](../../docs/subsystems/invariants.zh.md)。
