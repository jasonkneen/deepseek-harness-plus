# bundle/ — profile plugin bundles

English | [中文](README.zh.md)

Profile bundles: npm packages whose manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, making them installable patch layers for `dsh --profile` compositions ([profile contract](../boot/app-boot/README.md#profiles)). A bundle's substance is its patch list; some also ship runtime glue plugins their patch mounts.

The manifest declaration, not this directory, defines Bundle identity. Domain packages can carry their own optional Profile layer; the [Codex and Claude Code subagent packages](../subagent/README.md) are directly installable examples.

| Package | Role | ctx key |
|---|---|---|
| [`base/`](base/README.md) | The shared dsh core applied first by base-backed profiles | — (patch only) |
| [`acp-app/`](acp-app/README.md) | Automation-only ACP stdio application over base | mounts the ACP bridge |
| [`web-app/`](web-app/README.md) | Browser surface: web patch layer + runtime glue plugin | mounts rows |
| [`headless/`](headless/README.md) | Direct one-shot task mode over base, with no Host or Web layer | mounts `headless-runner` |
| [`sdk-app/`](sdk-app/README.md) | SDK stdio JSON-RPC application over base | mounts the SDK server |
| [`sdk-minimal/`](sdk-minimal/README.md) | Standalone minimal SDK application without base or Web | — (complete patch tree) |

In-box bundles resolve from the dsh installation; out-of-tree bundles install into a profile through `dsh plugin --profile <name> add <package>`.
