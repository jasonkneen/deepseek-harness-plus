# dsh-util-crypto

English | [中文](README.zh.md)

Zero-dependency v4 UUID minting over `crypto.getRandomValues` — the one random primitive every shipped context provides. `crypto.randomUUID` is a secure-context Web API: a page or worker served over plain HTTP on a LAN address (the browser preview deployment) has no such method, so code that must run there cannot call it. The repository-wide `no-restricted-properties` lint rule points `crypto.randomUUID` callers here; Node-only code importing `randomUUID` from `node:crypto` stays as it is.

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no state.

## API

```ts
import { randomUUID, type Uuid } from '@deepseek-ai/dsh-util-crypto'
```

| Export | Role |
|---|---|
| `randomUUID()` | Random RFC 9562 v4 UUID string, minted from `crypto.getRandomValues`. Drop-in for `crypto.randomUUID()`. |
| `Uuid` | The five-group UUID string type, matching `crypto.randomUUID`'s declared return shape. |

## Model Experience

Indirectly, through consumers that mint request, session, and attachment identifiers with it, none of which enter prompts as semantic content.

#### KV Cache effect

No direct invalidation; identifier-minting consumers own any request changes.

## Known Limitations and Deferred Work

- **v4 only** — no other UUID versions, namespaces, or parsing; consumers needing more should take a real UUID dependency.
- **Uniqueness is probabilistic** — 122 random bits, the same guarantee `crypto.randomUUID` gives; nothing here detects collisions.
