# Agent Note: Windows Python runtime CI stays on GitHub-hosted Windows

Status: implemented

English | [中文](2026-09-06-python-runtime-windows-hosted.zh.md)

## Problem

The Windows x64 target in [build-exe-for-python-sdk.yml](../../../../.github/workflows/build-exe-for-python-sdk.yml) started resolving through `DSH_CI_FAILOVER_WINDOWS=selfhosted` for trusted pull-request CI when #3629 added the failover selector and the job-private Windows toolchain. The shared `dsh-win-ci` pool did not make the lane more reliable. On 2026-09-06 the installed-wheel smoke passed at 09:12 on `dsh-win-ci-16` for [an earlier commit of the same pull request](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34023970384), then failed at 10:06 on `dsh-win-ci-21` for [another pull request](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34026500701) and at 10:46 on `dsh-win-ci-04` for [the same pull request](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34028339888/job/101473395734), where `smoke_sdk_profile_plugin`'s packaged `dsh plugin add` child exited without output while the Linux and macOS cells of that run passed. The migration proposal ([#3629](https://github.com/deepseek-harness/deepseek-harness/pull/3629)) remained `proposed` because its throughput and shared-load acceptance criteria were never measured.

## Decision

The Windows x64 target always uses its hosted `matrix.runner` — `windows-2025` for pull-request CI — with the standard setup-python toolchain, the pnpm cache restore, and the pkg cache. The failover selector, the job-private Python setup step, the self-hosted dependency install and post-step cleanup, the private setup script, and the routing spec from #3629 are removed. `DSH_CI_FAILOVER_WINDOWS=selfhosted` again retargets only the native Windows jobs in [ci.yml](../../../../.github/workflows/ci.yml); the [failover runbook](2026-07-26-ci-failover-runbook.md) and [python/development.md](../../../../python/development.md) describe hosted-only runtime builds. The migration's UTF-8 mode exports existed because the persistent host used a GBK default code page; hosted images provide the locale the lane previously ran under.

## Alternatives considered

**Keep the failover routing.** Rejected: the shared pool reproduced the same silent installed-wheel child death twice in one day while the migrated inventory's throughput acceptance stayed open, and routing a correctness lane through failover state couples it to an unrelated pool-outage switch.

**Fix the shared pool instead.** Left to pool operators: the observed failures are subprocesses dying without output, not a missing image prerequisite, and the same image serves the native Windows failover jobs.

**Retain the job-private toolchain on hosted images.** Rejected: the private uv/Python download exists to avoid mutating a persistent shared host; disposable hosted images already provide the registered Python 3.10 toolchain the pre-migration lane used.

## Consequences

Every qualifying pull request again pays GitHub-hosted Windows capacity for the runtime build, and the job-private setup and cleanup machinery — including the bounded filesystem retries — is gone with the lane. In exchange each build runs on a disposable host with the proven toolchain and hosted caches, and the Windows failover switch covers only the native Windows jobs as documented before the migration. A future self-hosted attempt must re-validate throughput and failure reproducibility on the actual pool before any routing change.
