# Agent Note: Job-private Windows Python runtime CI

Status: rejected — no measured throughput win; the shared pool reproduced the installed-wheel failure and the lane returned to hosted Windows

English | [中文](2026-09-06-python-runtime-windows-selfhosted.zh.md)

## Problem

The native Python runtime matrix consumes hosted Windows capacity, but moving its build unchanged onto shared persistent runners would modify machine installation state and reuse user-level caches. The [CI failover runbook](../../implemented/process/2026-07-26-ci-failover-runbook.md) remains the owner of the existing general-purpose lanes and pool prerequisites; the [native Windows CI note](../../implemented/process/2026-08-08-native-windows-pull-request-ci.md) owns the independent Wine/native topology. This proposal covers only Python runtime builds.

The [read-only prerequisite probe](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34012679056) found native Windows x64, Python 3.14.7 with venv/ensurepip, and enabled Developer Mode, but no Python toolcache. Linux lacked Docker, which both manylinux steps require. These observations permit a Windows-only experiment, not a claim that the runtime build passes.

## Proposal

Route only the Windows x64 target in [the runtime workflow](../../../../.github/workflows/build-exe-for-python-sdk.yml) to the persistent pool when `inputs.ci && !inputs.release`, the repository is the canonical repository, and the event is a same-repository non-fork, non-Dependabot PR. `DSH_CI_FAILOVER_WINDOWS=selfhosted` enables this routing; an unset or different value keeps the lane hosted. Release/manual builds, other events, Linux/macOS targets, planning, and the SDK-wheel job remain hosted. Throughput comparison and concurrent-job/cancellation acceptance remain pending.

The [native setup probe](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34013261224/job/101432611073) downloads Python 3.10.20, verifies command resolution and a seeded smoke venv, asserts unchanged registered Python installations and Developer Mode, and proves job-root deletion. Windows recursive removal needs bounded retries after an observed non-empty-directory failure. The workflow additionally clears the exported compile-cache path and resets temporary-directory variables before action post-steps; focused tests pin those assignments, which are not part of the cited probe commit. The focused routing tests pass, and an inverted failover condition produces three expected failures before restoration. The first full native run builds the executable and wheel but fails when Python reads UTF-8 Session JSONL with the host GBK default. The setup exports Python UTF-8 mode and UTF-8 standard streams; a local forced-ASCII-locale subprocess reproduces the default-decoding failure and verifies the setting. The [corrected native Windows job](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34014942421/job/101437029350) completed successfully in 523 seconds, including executable and release-shaped wheel builds, installed-wheel keyless/live-API tests, upload, private-root cleanup, and action post-steps.

The [private setup script](../../../../scripts/setup-python-runtime-windows.ps1) bootstraps uv 0.11.23 inside a temporary venv using the preinstalled interpreter, then downloads managed Python 3.10 into a unique job directory with `--no-bin --no-registry`. It creates a seeded tooling venv without further Python downloads. These flags exist in the [pinned uv source](https://github.com/astral-sh/uv/blob/3cdf50e0924f1ace7a92ddbac98b12a958b87688/crates/uv-cli/src/lib.rs#L6672-L6713); the [implementation](https://github.com/astral-sh/uv/blob/3cdf50e0924f1ace7a92ddbac98b12a958b87688/crates/uv/src/commands/python/install.rs#L667-L723) suppresses executable links and registry registration. CI checks Developer Mode rather than enabling it.

The job owns its pnpm store, pkg/npm/node-gyp/Python/Node caches and temporary test directories. Dependency imports use copy rather than links into a shared store; hosted cache restore/save steps are skipped. An always-run cleanup removes only the recorded job root. Checkout does not persist credentials. These are resource-isolation measures, not protection against malicious code running under the same Windows account.

## Alternatives considered

**An independent Python failover switch.** Rejected for this shared host: reusing `DSH_CI_FAILOVER_WINDOWS` lets responders recover the platform with one switch and adds no variable. The trade-off is coupled placement: enabling native Windows failover also adds eligible Python runtime builds and their cold private-tool/cache setup load to the same host; clearing it returns both workloads to hosted pools.

**Cold setup-python with a private toolcache.** Rejected: the concrete Python 3.10.11 [Windows release installer](https://github.com/actions/python-versions/blob/98e79473eb342d6f43487a289ca633620404742e/installers/win-setup-template.ps1#L21-L70) removes matching machine/current-user installation records and installs for all users. A private directory does not isolate that registry state.

**Administrator-preprovisioned Python 3.10.** Viable with enforced cache-hit-only use and private dependency environments, but the measured pool does not supply it. Portable uv avoids requiring a host installation change.

**Migrate Linux simultaneously.** Deferred until administrator-approved Docker provisioning and manylinux validation; skipping either manylinux step would weaken the wheel compatibility check.

## Acceptance criteria

- Selector tests prove hosted routing for release/manual, foreign/fork/Dependabot events, non-Windows targets, and an unset or unknown switch value.
- A trusted native Windows run builds the executable and release-shaped wheel, passes installed-wheel keyless and required live-API tests, and uploads the wheel without global Python or registry writes.
- Concurrent jobs use distinct cache/tool roots; success, failure, and cancellation exercise cleanup without deleting another job’s paths.
- Compare elapsed time and shared-pool load against hosted Windows before claiming cost or throughput improvement. Until then this note remains proposed.

## Risks

Private stores and copy imports trade warm-cache speed and disk space for bounded mutation. Portable Python can select a different 3.10 patch from setup-python. Downloads remain external dependencies; hard runner termination can prevent cleanup. Shared-account trust and pool availability remain operational limits, and the hosted fallback does not prove self-hosted readiness.
