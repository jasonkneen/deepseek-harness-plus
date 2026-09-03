# Agent Note: Required CI performance gate for opening large Sessions

Status: implemented

English | [中文](2026-09-04-session-open-performance-gate.zh.md)

## Problem

The Session format v2 rollout changed two paths whose cost scales with model output: the JSONL backend migrates and publishes a released-v0 log on its first `open()`, and the Client folds each settled reply's embedded compact stream. Neither path had an executed performance check, so a first open that grew from about 35 ms to about 5 s on a 127,400-event synthetic log (and from about 0.3 s to 26 s on a 575,000-chunk real log, with peak RSS of 2.7 GB and heap exhaustion under a 512 MB limit) and a Client fold that grew linearly with streamed deltas instead of compact records both reached master unnoticed. Unit tests use small logs, the coverage gate measures lines, and the existing `test:web:perf` inventory is a manual diagnostic outside CI.

## Decision

Linux pull requests run a required `node 24 / benchmarks` job that executes `pnpm run check:ci:bench` → `pnpm run test:bench` → `vitest.bench.config.ts`, which collects `packages/*/*/tests/**/*.bench.ts` and `*.bench.client.ts` and runs one file at a time. The job runs the benchmark lane alone, on the same runner selector and failover switch as the other required Linux workers, and joins the `all checks passed` verdict.

Every benchmark synthesizes its input in-process from fixed parameters: numbered prompts, counter tokens, fixed timestamps. Recorded Sessions are never used because they carry user content, differ between machines, and drift as fixtures are re-recorded. Each benchmark documents its budget beside the constant that enforces it, and budgets follow three rules: a wall-clock budget sits a small multiple above the intended cost and well below the regression it guards; a memory budget runs the measured path in a child Node process under a fixed `--max-old-space-size`, so an allocation regression fails as an out-of-memory exit regardless of the runner's physical memory; and a scaling assertion compares two sizes of the same workload so a complexity regression fails on any host speed.

The first two gates cover the two regressed paths:

| Benchmark | Workload | Gates |
|---|---|---|
| `packages/session/session-persistence-jsonl/tests/open-generation.bench.ts` | 200 turns × (500 text + 125 reasoning deltas) = 127,400 released-v0 events, about 2.8 MB, encoded through the frozen v0 codec with packed rows | migrating first `open()` ≤ 3,000 ms under a 128 MB heap; fresh-process open of the published current generation ≤ 500 ms; minimum of three attempts |
| `packages/client/ui-chat/tests/conversation-fold.bench.client.ts` | 200 replies whose compact streams hold 2,000 text + 500 reasoning deltas each (500,000 deltas in 1,600 records), folded through every Chat Definition by the real `ConversationNodeAssembler` | large fold ≤ 150 ms; large fold ≤ 3× the fold of the same window with 100 deltas per reply |

Measured on the reference machine at the commit that introduced the gate, the migration benchmark exhausted the 128 MB heap and the fold benchmark scaled 11× between the small and large windows, so both gates fail on the regressed code and pass once the paths do O(records) work.

## Alternatives considered

**Extend the manual `test:web:perf` inventory.** Rejected: it stays outside CI by design, measures a simplified fold rather than the registered Definitions, and asserts nothing.

**Time-only budgets.** Rejected: a single absolute budget either fails on slower runners or passes a regression on faster ones; the heap cap and the scaling ratio give host-independent verdicts, and the wall-clock budget remains as the timeout that the user-visible symptom is about.

**Benchmark the real recorded corpus.** Rejected: corpus fixtures are small by policy, recorded material must not become a benchmark input, and their re-recording would silently move the baseline.

**Run the benchmarks inside an existing gate aggregate.** Rejected: aggregates run gates concurrently on one runner, so wall-clock measurements would inherit the neighbours' CPU load.

## Consequences

Every pull request pays one more required Linux job of a few minutes, dominated by install time rather than the benchmarks themselves. A change that makes first open or the Client fold slower than its budget, heavier than its heap limit, or proportional to streamed deltas fails in the PR that introduces it, with the measured numbers printed in the job log. A budget change is a reviewed edit of the constant and its rationale comment, never an environment override, and a new benchmark must state which owner-visible path and which regression class it guards. The gate does not measure browser rendering, network transfer, or real recorded Sessions; those remain covered by the manual `test:web:perf` inventory and by review.
