# examples/ — reusable composition bundles

English | [中文](README.zh.md)

Pre-composed plugin bundles for tests and custom deployments that need the concrete Agent spine without assembling it by hand. The `-demo` npm suffix marks each package as support infrastructure rather than a product interface.

| Package | npm name | Role |
|---|---|---|
| [`agent-spine-demo/`](agent-spine-demo/README.md) | `@deepseek-ai/dsh-agent-spine-demo` | Reusable agent-spine bundle |

`agent-spine-demo` is the shared bundle. Product SDK, ACP, and one-shot execution belong to `dsh --profile sdk` / `dsh --profile sdk-minimal`, `dsh --profile acp`, and `dsh --profile headless`; no package in this directory provides an application entry.

These packages are not product API. Product seams and entry points remain in their owning groups; support bundles select concrete compositions for focused consumers.
