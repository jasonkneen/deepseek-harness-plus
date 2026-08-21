# Agent Note: Ordinary subprocesses use native managed ranges where supported

Status: implemented

English | [中文](2026-08-20-subprocess-native-containment.zh.md)

## Problem

The local subprocess provider treated a POSIX process group or a Windows direct-parent tree as the managed range. A descendant could call `setsid`, double-fork, or outlive the direct parent, so `terminate()` could miss work that `waitForExit()` had already declared gone. The direct command result and the complete managed range are different lifecycle facts and must not be collapsed into one wrapper exit code.

## Decision

`LocalSubprocessRuntime` selects ordinary native containment once, before its first user command. Linux uses a transient user-systemd scope only when the user manager is readable and `systemd-run` supports `--expand-environment=no`. Windows uses a local runner backed by `@deepseek-ai/dsh-win32-process`; it creates the target suspended, assigns it to a kill-on-close Job, and resumes it only after assignment. Each launch binds a package-private owner with only `signal()` and `waitForExit()` responsibilities.

The common spawn lifecycle still owns stdio dispositions, bounded collection, direct outcome, abort handling, termination scheduling, and host-exit registration. Linux scope and POSIX process-group owners deliver TERM and then KILL after the configured grace; Windows Job and `taskkill` owners force-terminate on the first request. `.done` comes from the target process. A private `0600` single-spawn request/event transport lets the Linux or Windows runner report Node-shaped target spawn failures and the target exit independently of the scope or Job lifetime. `waitForExit()` succeeds only after the same owner used by `terminate()` confirms that the OS range is empty; once confirmed, the owner permanently ignores later signals.

Linux user argv never enters the `systemd-run` command line. The runner consumes it from the private request, spawns the target with the exact cwd and scrubbed-plus-explicit environment, and reports the direct result. The packaged carrier re-enters its executable through the private dispatch owned by the [single-file runtime](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md), and the Linux capability probe invokes that same runner entry before selecting native mode. Scope TERM leaves the runner alive long enough to report a TERM-trapping target. If scope KILL prevents a final target event, the Linux launch reports `SIGKILL` only after that KILL was attempted and the owner proves the scope empty; an unrelated runner or manager failure still rejects. On Windows the parent creates private named-pipe endpoints for non-inherited streams, while the runner opens only the target-side handles. That runner creates the target suspended, assigns it to its unnamed kill-on-close Job, resumes it, publishes the target identity, and closes its pipe handles in the same synchronous startup step before processing control messages. It retains the original target process handle and Job until it has reported direct exit and `QueryInformationJobObject` reports zero active members. The parent never opens the target process or Job; IPC termination and disconnect remain the only control path into the runner.

When native capability is unavailable before target execution, the provider warns once and uses the existing PGID or `taskkill /T` fallback. macOS always takes that path because it has no supported public persistent process owner. After native launch is selected, any runner, manager, or result-transport failure is reported; the user command is never replayed through fallback.

## Verification

Linux native evidence on Ubuntu 24.04 x86_64 with systemd 255.4 runs one real `setsid` and reparenting scenario plus Node-shaped spawn failures without replay. Windows native evidence covers one default-inheritance descendant scenario plus raw stdin, direct stdout/stderr EOF, direct result versus Job quiescence, and target spawn failures. Shared tests pin literal argv, one-time fallback warnings, unreadable-owner rejection, no post-stop signals, abort and host-exit routing, and source, built, and packaged-executable runner entries.

## Alternatives considered

**Scan the process table for escaped descendants.** Rejected because parent and PID snapshots do not provide a persistent ownership fact and can follow PID reuse.

**Expose a public backend selector or generic launch framework.** Rejected because callers need one subprocess contract, while systemd and Job creation have different launch mechanics. Only the signal/wait owner is common.

**Move the Windows Job or direct-process observation into the parent.** Rejected because a named Job, cross-process open, release handshake, or second process handle would duplicate runner-owned lifecycle facts without producing a second user result. The parent owns only public stdio endpoints and runner control.

**Support legacy systemd argument expansion.** Rejected because shell-style expansion can change user argv. Hosts without the literal-argument option use the disclosed fallback.

**Use private macOS coalition APIs.** Rejected because no supported public owner gives the required membership and settlement contract.

## Consequences

Supported Linux and Windows hosts retain descendants after session changes or reparenting, and termination and settlement read one OS-owned range. The first ordinary spawn probes capability once per provider instance with a 5-second bound per probe command. The local native path then requires a bounded per-launch handshake before it can publish the target pid; the fixed upper bound is 10 seconds when a runner never reports, and each native range retains one runner process until settlement. Windows also creates private per-spawn named-pipe endpoints, but no named Job or parent target-process handle. After publication, event-file reads use asynchronous 100 ms polling and systemd state reads use asynchronous 200 ms polling rather than blocking the host event loop. Windows managed ranges terminate immediately; `graceMs` still bounds collected-pipe draining. The private runner adds one built entry and short-lived private files but no public configuration or durable format. Windows breakaway descendants remain outside the guarantee, and external termination in the narrow CreateProcess-to-Job-assignment interval can leave a suspended target. Fallback hosts remain usable with an explicit weaker guarantee.
