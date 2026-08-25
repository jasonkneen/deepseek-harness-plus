# sdk/ — drive Harness runtimes from another process

English | [中文](README.zh.md)

This group contains the protocol stack for driving a Harness runtime from another process. The TypeScript and Python clients both launch `dsh` with a named profile and ordered patches; no package in this group defines a separate application. The [TypeScript SDK decision](../../.agents/notes/implemented/feature/2026-07-27-typescript-sdk-and-sdk-subagent-backend.md) owns the client contract, and the [Python profile-runtime decision](../../.agents/notes/implemented/architecture/2026-08-23-python-sdk-dsh-profile-runtime.md) owns the packaged Python launch.

| Package | Role |
|---|---|
| [`protocol/`](protocol/README.md) | Defines the SDK runtime wire protocol |
| [`client/`](client/README.md) | Drives a Harness runtime through the TypeScript client API |
| [`server/`](server/README.md) | Serves out-of-process SDK clients over stdio JSON-RPC |
