---
description: "A zero-dependency no-shell execFile runner for host-native OS integrations, with utf8 stdio capture, abort propagation, and a hidden console window on Windows."
kind: "package-library"
---

# @deepseek-ai/dsh-native-command

English | [中文](README.zh.md)

## Summary

`dsh-native-command` runs a host executable directly — never through a shell string — and captures its utf8 stdout and stderr. The caller's abort signal terminates the child, and on Windows the transient console window stays hidden. A failed run rejects with the exit code and both captured streams attached, so callers classify a missing tool, a cancellation, or a real failure without re-running anything. The host-side consumers are the native directory chooser and the open-with-default-application hand-off. It is a library, not a plugin: no `ctx`, no state, no events.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this runner when a host-side integration must execute one native command and needs its output, its failure, or both — and must never involve a shell.

### Running a command

```ts
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'

declare const script: string
declare const signal: AbortSignal
const { stdout, stderr } = await runNativeCommand('osascript', ['-e', script], signal)
```

On exit 0 the call resolves with captured stdout and stderr. On any failure it rejects with the exit `code` and both captured streams attached, so a caller can tell a missing tool (`ENOENT`), a cancellation (`ABORT_ERR`), and a real command failure apart without re-running the command.

### Injecting the command boundary

The `NativeCommandRunner` type is the injectable command boundary for host integrations: pass the function (or a wrapper) where the integration needs a testable seam, so tests can substitute a fake runner.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The runner is a thin wrapper over Node's `execFile` with three fixed choices: utf8 encoding, abort propagation, and Windows console hiding.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `runNativeCommand` and the `NativeCommandRunner` type — the whole package |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; each run is one stateless child-process round trip) |

### What execFile gives the runner

`execFile` spawns the executable directly with an argv array — no shell string, no shell interpretation of the arguments. The `signal` option terminates the child when the caller's abort fires; `windowsHide` suppresses the transient console window on Windows. On a non-zero exit or spawn error, the callback attaches `code`, `stdout`, and `stderr` to the rejected error and keeps the original error as `cause`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the consumers or the general subprocess capability this utility deliberately is not.

- [Native directory picker](../../host/directory-picker-native/README.md) — the OS chooser commands this runner executes.
- [Host API proxy](../../host/apiproxy/README.md) — the open-with-default-application hand-off this runner serves.
- [Subprocess capability](../../subprocess/subprocess/README.md) — the general subprocess seam, of which this package is not a part.

-----

<a id="model-experience"></a>
## Model Experience

None, as the host-side subprocess runner registers nothing model-facing.

#### KV Cache effect

Nothing here enters a request prefix; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this runner is not the right tool. They are current package constraints, not a task backlog.

- **No output bounding** — both streams buffer unbounded in memory; every current caller invokes small native tools whose output is a path or an error line. Adopt `dsh-output-retention` bounding before pointing this at commands with meaningful output volume.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
