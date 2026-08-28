# Agent Note: Windows sandbox process primitives have one low-level owner

Status: implemented

English | [中文](2026-08-19-shared-win32-process-primitives.zh.md)

## Problem

The Windows ACL sandbox owns restricted-token, SID, DACL, grant, and workspace policy, but its process launch path also carried the generic Koffi ABI, command-line quoting, anonymous pipes, inherited stdio, Job setup, waits, and HANDLE cleanup. A second Windows process consumer would otherwise have to depend on sandbox policy or copy native resource logic, while fixes to allocation and failure cleanup would need to remain synchronized.

## Decision

`@deepseek-ai/dsh-win32-process` owns the reusable Win32 process ABI and native resource operations consumed by `sandbox-windows-acl` and the ordinary subprocess Job runner. The package lazily loads `kernel32.dll` and `advapi32.dll`, verifies the x64 `STARTUPINFOW` and `PROCESS_INFORMATION` layouts, quotes argv for `CreateProcessAsUserW` or `CreateProcessW`, and exposes checked anonymous-pipe, inherited-stdio, Job, wait, polling, termination, and handle operations.

The Windows ACL sandbox remains the only owner of restricted-token creation, SID and DACL policy, grants, writable-path decisions, temporary-directory policy, and the public sandbox child result. It extends the shared binding context with policy-specific APIs, supplies the primary token, combines pipe drains and waits, and closes the caller-owned Job at its lifecycle boundary.

Every native allocation and HANDLE has one owner within each shared operation. A process operation frees its Koffi out-parameters and closes every pipe, thread, process, or Job handle it acquired before a controlled failure. Successful anonymous-pipe creation returns the process plus stdout/stderr read handles to the sandbox. The ordinary runner temporarily restores inheritability on its own standard handles, passes those exact handles through `STARTF_USESTDHANDLES`, then closes its copies after target creation so target exit can produce EOF at the parent. Restricted and ordinary creation both start the target suspended, assign it to the kill-on-close Job, and resume it only after assignment, so target code cannot run outside the Job. The sandbox retains its existing pipe-drain and direct-wait lifecycle; the [native-containment runner](2026-08-28-subprocess-native-containment.md) uniquely retains the ordinary direct-process handle and unnamed Job, polls direct exit and active-process count, and closes the Job only after it is empty.

The current-token API is named `CurrentTokenProcessSpawnOptions` and `spawnCurrentTokenJobProcess`; no `Ordinary*` or `Unrestricted*` aliases preserve ambiguous semantics. The package exports only operations used by the two production consumers. Exact `applicationName`, parent-owned Node streams and IPC, public process handles, and backend selection remain outside. The package is a library, not a Cordis service or a public Windows SDK.

## Verification

The shared suite covers x64 ABI values, command-line quoting, binding extension, anonymous-pipe EOF and drain allocation reuse, inherited ordinary standard handles, restricted and current-token process creation, suspended creation followed by Job assignment and resume, blocking and zero-time exit reads, Job-empty probes and termination, native allocation release, and acquired-resource failure paths. Sandbox tests retain restricted-token, fail-closed, pipe/inherit, result, and disposal composition without duplicating the low-level matrix. The committed header probes and Windows package tests cover the native paths; Wine supplies the emulated Windows package and composition signal.

## Alternatives considered

**Keep process primitives inside the sandbox package.** Rejected because a process consumer would inherit ACL/token policy or duplicate the native ABI and cleanup paths.

**Copy the Koffi implementation into each consumer.** Rejected because struct layouts, error capture, and partial-failure cleanup would have multiple owners.

**Publish ordinary-runner operations before a current consumer exists.** Rejected because unused operations would freeze speculative obligations. The ordinary CreateProcess, polling, and Job controls were added only with their runner consumer.

## Consequences

The sandbox keeps its public behavior while generic Win32 resource ownership has one package and one test home. The package boundary adds one workspace dependency and a published library, and callers must explicitly own policy, scheduling, result composition, and returned HANDLE closure. Suspended creation guarantees that target code starts only after Job assignment, but it does not make the runner's create-to-assignment interval atomic against external termination. Future process consumers extend the low-level package only when their production path exists.
