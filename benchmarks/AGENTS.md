# AGENTS.md — Performance Benchmarks

This tree owns required, repository-level performance gates whose measured user path crosses package ownership. Package-local diagnostics remain beside their owners and use the `.perf.ts` suffix instead of joining `test:bench`.

- Organize benchmarks by measured user path, one directory per path. Do not mirror the package tree.
- Host cases use `*.bench.ts`; Client-face cases use `*.bench.client.ts`. Worker, fixture, and support modules do not carry a benchmark suffix.
- Synthesize fixed inputs from reviewed constants. Never use recorded Sessions, user material, ambient repositories, or network services.
- Run process-level wall-clock and retained-memory samples in fresh children with private `mkdtemp` roots. Pure synchronous folds create a fresh object graph per sample and must not mutate process-global state. Bound every child, await exit, and remove owned roots after failure as well as success.
- Report enough raw and aggregate measurements to explain each verdict, including whether a budget uses a median, minimum, absolute value, or ratio. Enforce reviewed source constants; environment variables must not override performance budgets.
- Keep scenario-specific support beside its benchmark. Move a helper into `benchmarks/support/` only after at least two benchmark directories require the same behavior.
- Exercise production entry points. Do not copy product algorithms, add production exports solely for measurement, or turn benchmark completion into duplicate semantic assertions.
- Record the workload, timing boundary, memory endpoint, calibration reference, alternatives, and known exclusions in the owning Agent Note.
