# Agent Note: Evidence-driven performance optimization workflow

Status: implemented

English | [中文](2026-09-06-evidence-driven-performance-skill.zh.md)

## Problem

Performance work can improve an isolated phase while moving cost into another phase, retaining more data, or skipping required behavior. Historical PR descriptions also retain abandoned implementations and estimates, so copying their apparent solution can restore a rejected design instead of addressing a current bottleneck.

## Decision

The [dsh-speed-up-perf skill](../../../skills/dsh-speed-up-perf/SKILL.md) guides broad surveys toward bounded, measured user paths. It combines focused attribution with independently timed backend and browser endpoints, synthetic workload distributions, comparable cold/warm and retained-memory conditions, and negative controls for tightened budgets. Its [evidence reference](../../../skills/dsh-speed-up-perf/references/pr-evidence.md) distinguishes merged implementations, superseded proposals, author-reported measurements, and estimates.

The workflow requires behavior evidence independently of timing: model-visible logs, durable generation and publication rules, stream ordering, cancellation, and disposal remain obligations. Authorized private corpus inspection yields only aggregate workload inspiration; committed inputs and published artifacts contain synthetic material. Optimization PRs carry their tighter budgets, while a preceding benchmark layer can protect the measured baseline and remain independently mergeable.

The [Session-opening performance-gate decision](../testing/2026-09-04-session-open-performance-gate.md) retains ownership of lane mechanics and calibration. The [simplification skill](../../../skills/dsh-find-simplifications/SKILL.md) retains ownership of deletion-oriented surveys. Neither is superseded: this workflow adds performance-specific candidate selection, measurement comparability, and stopping criteria rather than replacing their decisions.

## Alternatives considered

**Optimize suspicious code before measuring.** Rejected because local complexity does not identify dominant user cost and cannot establish improvement or regression protection.

**Treat historical speedups as reusable prescriptions.** Rejected because representation, ownership, and lifecycle requirements change. Historical evidence generates hypotheses; current production paths and fresh measurements decide whether a change applies.

**Use only microbenchmarks or only end-to-end timing.** Rejected because isolated phases can omit moved work, while aggregate timing alone cannot locate its cause. Both are required at the scope appropriate to the selected problem.

## Consequences

The skill adds no runtime behavior, benchmark implementation, or new CI policy. Its validation is document/link consistency and skill metadata; each future optimization supplies executable measurements and functional evidence at its owner. The finite scenario/fix scope prevents a broad performance request from becoming an unrelated architectural rewrite.
