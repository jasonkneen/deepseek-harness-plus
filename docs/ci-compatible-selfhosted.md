# Node compatibility CI runners

English | [中文](ci-compatible-selfhosted.zh.md)

## Summary

The three Node compatibility jobs can use the existing Linux self-hosted pool without changing their versions, required checks, or master scheduling. [CI](../.github/workflows/ci.yml) owns the runner selection; the [decision record](../.agents/notes/implemented/process/2026-09-06-node-compatibility-selfhosted.md) explains isolation and trade-offs.

## Table of Contents

- [Runner selection](#runner-selection)
- [Installation and cleanup](#installation-and-cleanup)
- [Verification](#verification)

<a id="runner-selection"></a>

## Runner selection

Node 22.19, 24.9, and 26 select `[self-hosted, linux, x64, vm-backup]` only when `DSH_CI_FAILOVER_LINUX=selfhosted` and the PR author is not Dependabot, the head repository matches the current repository, and the head repository is not a fork. All other cases select `ubuntu-latest`. The Python SDK job remains hosted.

Each matrix entry runs one repository gate at a time. The matrix retains independent jobs and does not cancel sibling versions on failure. Runner registrations share host resources; their count is not a count of independent machines.

<a id="installation-and-cleanup"></a>

## Installation and cleanup

Self-hosted Node installations use a tool cache beneath `runner.temp`. pnpm setup uses its runner-and-run-private destination. Node compile caches and node-gyp headers also stay beneath runner temp; the pnpm content-addressed store remains persistent. Hosted jobs retain their normal tool cache and pnpm caching. Self-hosted jobs do not restore or upload hosted package caches.

The runner owns temporary-directory cleanup between jobs. These jobs do not install system packages or change global Node symlinks. The shared image must already provide the compiler and Python dependencies needed by native npm packages. A cold temporary Node cache requires downloading the selected runtime again.

<a id="verification"></a>

## Verification

`pnpm exec vitest run scripts/ci-compatible-selfhosted.spec.ts scripts/ci-workflow.spec.ts` checks routing, hosted fallback, matrix preservation, cache paths, and the executed environment setup. The actual Node matrix on the self-hosted host remains the required platform verification; local workflow tests do not prove native runtime compatibility or capacity under concurrent PR load.

## Dev Note

None.
