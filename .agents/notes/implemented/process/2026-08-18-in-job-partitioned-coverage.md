# Agent Note: In-job partitioned coverage

Status: implemented

English | [中文](2026-08-18-in-job-partitioned-coverage.zh.md)

## Problem

Native Windows coverage was the longest feedback path in the complete pull-request inventory. Keeping the instrumented suite in one single-worker Vitest process avoided the worker loss and Node 24 CJS lexer failures seen with larger in-process pools, but a failure could take more than fourteen minutes to appear and the gate runner withheld the child output until completion.

The optimization must retain every test and the merged per-file 100% thresholds. It must also stay inside the existing coverage job: splitting one suite across multiple workflow jobs would add checkout, installation, artifact transfer, and a merge job to the required topology.

## Decision

The ordinary `pnpm run test:coverage` command remains one Vitest invocation. Linux coverage CI fixes `DSH_COVERAGE_PARTITIONS=4`, while native Windows fixes it at 16; no elapsed-time trigger changes either count while a run is in progress. The [coverage-exempt heavy suite](2026-07-31-coverage-exempt-heavy-suites.md) remains a separate uninstrumented gate.

When partitioning is enabled, `scripts/run-gates.ts` selects `pnpm run test:coverage:partitioned` for the instrumented gate. `scripts/coverage-partitions.ts` starts the configured Vitest children concurrently, each with one worker and one `--shard=<index>/<count>` option. Partition mode suppresses thresholds and coverage reporters in each child, gives every child a separate report directory, and writes one blob report per process.

The coordinator waits for every child, validates that the blob directory contains exactly the expected files, and then runs one `vitest --merge-reports ... --coverage` command. Only that merged command applies the repository's per-file statement, branch, function, and line thresholds, so a partition is never judged against an intentionally partial inventory.

`DSH_COVERAGE_MAX_WORKERS` continues to size the uninstrumented exempt gate and the ordinary non-partitioned path; it does not resize partition children. Build, production-site validation, and instrumented coverage start immediately on native Windows. The exempt gate needs the build and waits for instrumented coverage to settle, so its full-corpus children and temporary Oxlint probes do not compete with the sixteen partitions; it then receives four workers from the budget of 12. The observational inventory also waits for instrumented coverage, then overlaps the exempt gate within an eight-worker outer budget. Ordering uses `after`, so both groups still run after an instrumented failure; each gate's `needs` dependencies remain pass-required. Linux overlaps four instrumented partition processes with two exempt workers, restoring the ordinary path's former four-way instrumented concurrency while keeping every instrumented process single-worker.

## Failure and output semantics

Partition children stream stdout and stderr through the coordinator. The coverage gate opts into `run-gates` streaming, so test progress and failures reach CI logs as they occur without buffering the complete log in the scheduler. The coordinator also retains a bounded 64 KiB combined tail per child; when a child settles unsuccessfully, it prints the spawn error, exit code, or signal and repeats that tail before validating the complete blob set, keeping the specific Vitest failure beside the final partition diagnostic.

A normal failed test still emits a blob through `--coverage.reportOnFailure`, allowing the merge to report the complete coverage state before the coordinator returns failure. Spawn failure, signal termination, non-zero exit, a missing or extra blob, or a failed merge all make the gate fail. The coordinator removes only its owned coverage tree and unlinks a link-shaped path instead of recursively following it.

## Verification

`scripts/coverage-partitions.spec.ts` pins argument construction, package-script separator removal, one-worker partitions, the single merged threshold command, failed-test merging, failure diagnostics before complete-blob validation, waiting for sibling partitions after a spawn failure, and link-safe cleanup. `scripts/run-gates.spec.ts` pins opt-in selection, invalid-count rejection, the complete Windows inventory with its blocking split, and unbuffered streamed output. React fake-timer cases that can move between partitions advance timers inside `act()`; geometry-dependent portal tests stub their element rectangles so a different shard schedule cannot turn deferred updates or jsdom coordinates into coverage-only failures.

Completed native Windows comparisons measured two partitions near 405 seconds and sixteen partitions at 112.66–122.01 seconds. Sixteen is the fixed Windows count. The exempt gate waits for their merged verdict, so the partition phase overlaps only build and production-site validation: at most eighteen active execution units on a 16-core runner, rather than adding exempt workers to that peak. Two Linux samples measured the conservative two-partition configuration at 276.68 and 282.27 seconds; that configuration was stable but halved the ordinary path's four instrumented workers. Four partitions restore that fan-out, for six total coverage execution units on the 16-core hosted runner and at most 36 across the failover VM's six runner instances. These values come from completed runs or fixed capacity bounds; an unfinished run crossing an arbitrary elapsed-time mark is not evidence for increasing concurrency.

The native ARM64 VM runs the full transform corpus in 29.59 seconds without coverage partitions and in 25.44 seconds through the eight-child Vitest path. A concurrent self-hosted x64 job stretched the former serial test to 279.13 seconds while one instrumented partition reached 442.45 seconds. The Windows graph separates the partition and exempt phases before applying its fixed sixteen-way coverage fan-out.

## Alternatives considered

**Use workflow-level sharding.** Rejected because multiple jobs repeat setup and need artifact upload, download, and a merge dependency. The selected partitioning uses multiple processes inside one job and one workspace.

**Raise the Vitest worker count inside one instrumented process.** Rejected because completed Windows trials at higher fan-out exposed worker exits, fixture instability, and Node 24 CJS lexer failures. Separate single-worker processes preserve isolation while still executing the selected partitions concurrently.

**Use one partition count on every host.** Rejected because Linux's four-process run and Windows's sixteen-process run have different startup costs and resource ceilings. Each fixed configuration requires its own completed end-to-end evidence.

**Apply thresholds independently in each partition.** Rejected because every partition intentionally sees only part of the suite and would report false uncovered files. Threshold ownership belongs to the merged report.

**Overlap the Windows exempt gate with instrumented partitions.** Rejected because the full-corpus checker is fast in isolation but multiplies under partition contention. The post-coverage phase uses available workers for the exempt and observational checks without changing either verdict.

## Consequences

Coverage pays one Vitest startup/configuration cost per partition and one report-merge cost, but it avoids another workflow topology and keeps one final threshold verdict. Partition output may interleave, while the partition start labels and Vitest file identities retain attribution.

Linux and Windows use the same coordinator with platform-specific partition counts and surrounding worker budgets. Local coverage stays simple unless a caller explicitly chooses the partitioned package script and supplies a valid count greater than one.

Windows uses two resource phases inside the same job: sixteen isolated coverage processes through the merged threshold verdict, then the four-worker exempt gate beside lightweight observational checks.

Future tuning starts from completed runs at one fixed configuration. Slow progress alone never raises partition count or outer concurrency, because repeated restarts would erase the only evidence needed to choose a stable setting.
