# Agent Note: Native Windows blocks the pull-request aggregate

Status: implemented

English | [中文](2026-08-22-native-windows-blocks-pull-request-aggregate.zh.md)

## Problem

Wine reaches blocking win32 toolchain paths quickly, but it cannot prove behavior that depends on the NT kernel, NTFS, PowerShell, Windows process control, or native addons. An `all checks passed` result that can succeed while the complete native job is pending or failed does not enforce the repository's supported Windows behavior.

The native job runs the complete supported-source coverage denominator and its owning Windows acceptance inventory. Its optimized 16-core hosted run completes within the five-minute target, making that higher-fidelity result short enough for the required pull-request path.

## Decision

The `all-checks-passed` job in [ci.yml](../../../../.github/workflows/ci.yml) lists both `windows` and `windows-native` in `needs`. Its existing `if: always()` verdict treats a failed, cancelled, or skipped native job like any other unsuccessful dependency, so `all checks passed` cannot succeed until the real-Windows job succeeds.

Branch protection continues to require the single stable `all checks passed` context rather than adding the native job name as another protected context. The [dual Windows topology](2026-08-08-native-windows-pull-request-ci.md) owns each job's host, failover selector, and inventory; this note owns their blocking relationship. The aggregate bookkeeping job follows the Linux failover selector for its own runner while `needs` independently waits for the pool selected by `DSH_CI_FAILOVER_WINDOWS`.

## Alternatives considered

**Keep native Windows informational.** This preserves the shortest aggregate path, but permits a merge while the highest-fidelity supported Windows verdict is pending or red.

**Require `windows node 24 / native complete` directly in branch protection.** This duplicates workflow topology in repository settings and makes a job-name change a control-plane migration. The aggregate already provides one stable required context and fails closed over unsuccessful dependencies.

**Remove Wine from the aggregate.** Native Windows provides higher fidelity, but Wine still returns a faster win32 build and production-site signal, preserves the compatibility topology, and gives maintainers earlier failure evidence while the native inventory runs.

## Consequences

Every merge waits for native Windows runner capacity and for the complete native job to finish. A failure, cancellation, or skip in that job makes `all checks passed` fail; a passing Wine job alone is insufficient.

The workflow remains one pull-request Action with one native Windows job, unchanged test coverage, and unchanged gate semantics inside that job. The required aggregate gains the native job's measured duration without adding a separately managed branch-protection context.
