# test-support/ — development and test infrastructure

English | [中文](README.zh.md)

These packages support repository development, tests, and examples rather than product APIs. Their compatibility follows the development need they serve.

| Package | Role |
|---|---|
| [`session-snapshot/`](session-snapshot/README.md) | Provides session-log snapshot support and protocol adapters |
| [`agent-loop-testkit/`](agent-loop-testkit/README.md) | Mounts shared prerequisites for AgentLoop tests |
| [`invariants/`](../runtime-diagnostics/invariants/README.md) | Runs development-time runtime-contract assertions |
| [`loader-smoke/`](loader-smoke/README.md) | Launches Loader-composed applications for smoke tests |
| [`llm-mock-server/`](llm-mock-server/README.md) | Provides a deterministic OpenAI-compatible fault server |
| [`llm-replay/`](llm-replay/README.md) | Replays recorded model responses for keyless tests and demos |

A package moves out of `test-support/` when it gains a product contract and product consumers.

The invariants contract is documented in [docs/subsystems/invariants.md](../../docs/subsystems/invariants.md).
