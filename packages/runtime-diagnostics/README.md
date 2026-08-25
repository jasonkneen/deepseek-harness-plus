# runtime-diagnostics/ — package-owned runtime checks

English | [中文](README.zh.md)

Configurable diagnostics that check package-owned runtime relationships without changing product behavior.

| Package | Role | ctx key |
|---|---|---|
| [`invariants/`](invariants/README.md) | Registers and runs package-owned runtime invariant companions | `ctx.invariants` |

See [runtime invariants](../../docs/subsystems/invariants.md) for selection, lifecycle, and package-attributed failure semantics.
