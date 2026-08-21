# Agent Note: Ordinary subprocesses use native managed ranges where supported

Status: implemented

English | [中文](2026-08-20-subprocess-native-containment.zh.md)

## Problem

The local subprocess provider treated a POSIX process group or a Windows direct-parent tree as the managed range. A descendant could call `setsid`, double-fork, or outlive the direct parent, so `terminate()` could miss work that `waitForExit()` had already declared gone. The direct command result and the complete managed range are different lifecycle facts and must not be collapsed into one wrapper exit code.

## Decision

`LocalSubprocessRuntime` selects ordinary native containment once, before its first user command. Linux uses a transient user-systemd scope only when the user manager is readable and `systemd-run` supports `--expand-environment=no`. Windows creates and retains a named kill-on-close Job; a local runner backed by `@deepseek-ai/dsh-win32-process` opens that Job, creates the target suspended, assigns it, and resumes it only after assignment. Each launch binds a package-private owner with only `signal()` and `waitForExit()` responsibilities.

The common spawn lifecycle still owns stdio dispositions, bounded collection, direct outcome, abort handling, termination scheduling, and host-exit registration. Linux scope and POSIX process-group owners deliver TERM and then KILL after the configured grace; Windows Job and `taskkill` owners force-terminate on the first request. `.done` comes from the target process. A private `0600` single-spawn request/event transport lets the Linux or Windows runner report Node-shaped target spawn failures and the target exit independently of the scope or Job lifetime. `waitForExit()` succeeds only after the same owner used by `terminate()` confirms that the OS range is empty; once confirmed, the owner permanently ignores later signals.

Linux user argv never enters the `systemd-run` command line. The runner consumes it from the private request, spawns the target with the exact cwd and scrubbed-plus-explicit environment, and reports the direct result. The packaged carrier re-enters its executable through the private dispatch owned by the [single-file runtime](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md), and the Linux capability probe invokes that same runner entry before selecting native mode. Scope TERM leaves the runner alive long enough to report a TERM-trapping target; if scope KILL prevents a final target event, `.done` rejects rather than inventing an outcome. Windows target descendants inherit the parent-owned Job by default. The runner opens that Job only for suspended create, assignment, and resume; after the parent opens its own direct-process wait handle, it releases the runner through their private IPC channel. The parent then observes the target exit, terminates the Job, and polls `ActiveProcesses` without retaining a runner-owned copy of the target's stdio. Raw pipe EOF therefore follows the target and descendants that actually inherited the stream. Host exit closes the parent's owner handle, and any still-open runner assignment handle closes as the runner exits, so kill-on-close terminates remaining members.

When native capability is unavailable before target execution, the provider warns once and uses the existing PGID or `taskkill /T` fallback. macOS always takes that path because it has no supported public persistent process owner. After native launch is selected, any runner, manager, or result-transport failure is reported; the user command is never replayed through fallback.

## Verification

Linux native evidence ran against an Ubuntu 24.04 x86_64 user manager with systemd 255.4 and covers a real `setsid` descendant, a double-fork daemon whose direct parent exits first, and Node-shaped spawn failures without replay. Windows native evidence covers a default-inheritance descendant and a descendant that remains after the direct target exits. Shared tests pin direct exit versus range quiescence, literal argv, one-time fallback warnings, no post-stop signals, abort and host-exit routing, and source, built, and packaged-executable runner entries.

## Alternatives considered

**Scan the process table for escaped descendants.** Rejected because parent and PID snapshots do not provide a persistent ownership fact and can follow PID reuse.

**Expose a public backend selector or generic launch framework.** Rejected because callers need one subprocess contract, while systemd and Job creation have different launch mechanics. Only the signal/wait owner is common.

**Support legacy systemd argument expansion.** Rejected because shell-style expansion can change user argv. Hosts without the literal-argument option use the disclosed fallback.

**Use private macOS coalition APIs.** Rejected because no supported public owner gives the required membership and settlement contract.

## Consequences

Supported Linux and Windows hosts retain descendants after session changes or reparenting, and termination and settlement read one OS-owned range. The first ordinary spawn probes capability once per provider instance with a 5-second bound per probe command. The local native path then requires a bounded per-launch handshake before it can publish the target pid; the fixed upper bound is 10 seconds when a runner never reports. The Windows runner remains only until the parent acquires direct-process observation, while the Linux runner remains until the direct target result and the OS-owned scope or parent-held Job persists for later descendants. After publication, Linux event-file reads use asynchronous 100 ms polling, Windows direct-process state uses 10 ms polling, and Linux scope state uses 200 ms polling rather than blocking the host event loop. Windows managed ranges terminate immediately; `graceMs` still bounds collected-pipe draining. The private runner adds one built entry and short-lived private files but no public configuration or durable format. Windows breakaway descendants remain outside the guarantee, and external termination in the narrow CreateProcess-to-Job-assignment interval can leave a suspended target. Fallback hosts remain usable with an explicit weaker guarantee.
