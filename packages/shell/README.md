# shell/ — bash capability family

English | [中文](README.zh.md)

The capability family spans the canonical executor seam, its implementations, the shared shell environment, and the model-facing tools. All are **product** packages.

| Package | Role | ctx key |
|---|---|---|
| [`shell/`](shell/README.md) | Defines the executor contract shared by Service Providers and Consumers. | `ctx.shell` |
| [`bash-local/`](bash-local/README.md) | Executes commands through the local [`subprocess`](../subprocess/README.md) service. | (registers `ctx.shell`) |
| [`bash-sandbox/`](bash-sandbox/README.md) | Applies the configured [`sandbox`](../sandbox/README.md) backend before local execution. | (registers `ctx.shell`) |
| [`pwsh-local/`](pwsh-local/README.md) | Executes PowerShell commands with Windows-specific process behavior. | (registers `ctx.shell`) |
| [`shell-env/`](shell-env/README.md) | Provides the managed `DSH_*` environment shared by shell tools. | `ctx.shellEnv` |
| [`tool-bash/`](tool-bash/README.md) | Exposes Bash execution and background-job integration to the model. | (registers on `ctx.tools`) |
| [`tool-pwsh/`](tool-pwsh/README.md) | Exposes PowerShell execution to the model. | (registers on `ctx.tools`) |

A profile layer selects one executor implementation and the model-facing tools it needs. A sandboxed composition also selects a `ctx.sandbox` provider; the [base bundle](../bundle/base/cordis.patch.yml) owns the shipped wiring.

The subsystem reference — request/spec vocabulary, results, background processes, the service, and events — is [docs/subsystems/shell.md](../../docs/subsystems/shell.md).
