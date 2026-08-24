# examples/ — ready-to-run demo bundles

English | [中文](README.zh.md)

Pre-composed plugin bundles a thin leaf `cordis.yml` loads instead of assembling the spine by hand. These are **demo / reference** packages — the `-demo` npm suffix marks each one as non-product surface, readable straight off the package name. Runnable leaves under the repo-root [`examples/`](../../examples/AGENTS.md) are the consumers; each is just its swappable backends plus one bundle entry.

| Package | npm name | Role |
|---|---|---|
| [`agent-spine-demo/`](agent-spine-demo/README.md) | `@deepseek-ai/dsh-agent-spine-demo` | Reusable agent-spine bundle |

`agent-spine-demo` is the shared bundle. Product SDK, ACP, and one-shot execution belong to `dsh --profile sdk`, `dsh --profile acp`, and `dsh --profile headless`; no package in this directory provides an application entry.

These packages are not product API. Product seams and entry points remain in their owning groups; demo bundles select concrete compositions.

Do not confuse this group with the repo-root [`examples/`](../../examples/AGENTS.md): that directory holds the runnable `cordis.yml` **leaves**; this group holds the **bundles** those leaves load.
