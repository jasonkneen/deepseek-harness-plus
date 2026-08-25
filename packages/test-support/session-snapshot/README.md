# `@deepseek-ai/dsh-session-snapshot`

English | [中文](README.zh.md)

Session-log snapshot support for the keyless snapshot tier (`pnpm run test:snapshot`, [testing policy](../../../docs/testing.md)). Transport-neutral manifests, typed identity redaction, normalization, write-back, and fixture invariants are shared by the headless, SDK, ACP, and Web adapters. Their tests launch or compose the shipped `dsh` profile surface; the support package does not provide another application entrypoint.

Every recorded-session directory carries a closed `snapshot.yml` manifest. `scenario` repeats the directory name for move diagnostics, `profile` names the shipped `dsh` controller, `composition` groups scenarios under one profile patch and request-header pin, `recording` distinguishes live-recordable sessions from deliberately authored scripts, and `header` records pin and sidecar ownership. `replay`, `platform`, `permission`, `environment`, `workspace`, and `input` hold only facts the completed session cannot reconstruct; inline attachment bytes are the standard exceptional input. A directory owns its local `session.jsonl` unless `session.source` names another scenario's read-only canonical recording. Unknown fields, JavaScript YAML tags, malformed names and indexes, absolute paths, and platform-specific separators fail during collection.

`workspace/` contains scenario-local initial files. A scenario that changes its cwd sets `workspace.final: true` and commits the complete user-visible result under `workspace.expected/`; an otherwise-empty result keeps an ignored `.empty` marker so Git retains the directory. Replay compares files, binary bytes, links, and empty directories after the controlled interface settles. Record and refresh never rewrite this independent expected state, so a transcript that merely claims a mutation still fails.

Committed sessions use typed first-seen tokens such as `{{session:1}}`, `{{message:4}}`, and `{{approval:1}}`. One map covers the primary and every child so parent links, relays, and repeated message identities stay test-visible. Arbitrary user and tool prose is unchanged unless it contains a value already identified by a typed field. Request system prompts and tool schemas never remain in session JSONL; each composition/header class has one structural pin, while identical prompt or schema bytes reference one readable sidecar owner.

The current ACP adapter has four importable layers:

- **`launchAcpTestAgent` (launcher)** — boots a source entry under tsx or a built `lib` entry under plain Node from a supplied cwd, connects the SDK client over a raw-byte stdout tee, collects session updates and stderr, surfaces asynchronous spawn failures through startup, fails closed on unhandled permission requests, and owns graceful or signalled shutdown. Product suites name a `dsh` profile: the launcher passes the base and selected scenario patches through `--patch`, selects the scenario's sibling `*cordis.snapshot.yml` in replay, and materializes temporary copies whose relative plugin modules become absolute file URLs. Test-only fake bins may omit the profile and retain their own config grammar. Shutdown waits for process exit, inherited stdio closure, and ACP parser exhaustion before resolving or propagating a child error, so captures are complete and callers can remove owned paths after either outcome.
- **`runScenario` (harness)** — drives ACP JSON-RPC stdio from a deterministic `input.json` script through the launcher, tees raw stdout for the expected-output and purity checks, and harvests every persisted raw JSONL session log (parent and subagent children, primary-first) after graceful stdin EOF. `AgentUnderTest` supplies absolute `binScript`, optional `libBinScript`, `configPath`, and `tsconfigPath` paths because the subprocess cwd is outside the repo; `workspaceParent` may move the generated child cwd from the platform temp directory when that grant is itself under test. Startup failures preserve captured agent stderr in the rejected diagnostic.
- **Normalizers** — pure functions turning captured surfaces into stable text or portable fixtures: `normalizeStdout` (JSON-RPC ids → first-seen sequence; UUIDs and every native/JavaScript filesystem spelling of the generated cwd → tokens, longest-first; cwd-rooted separators selected as canonical `/` or host-native; doubles as the stdout-purity check), `normalizeSessionLog` (sequence envelopes retained, times zeroed, the same cwd-path policy), `normalizeSessionSnapshot` (session-log normalization followed by request-header scrubbing and body-envelope projection), `tokenizeSessionFixtureCwd` (the generated workspace and its filesystem aliases → one canonical `{{cwd}}`, including an already-tokenized macOS `/private` alias; authored temp paths unchanged), `scrubSystemPrompts` (prompt text → `{{system}}`), `scrubToolSchemas` (schema bulk → `{{tools}}`), `scrubRequestHeaders` (all header bulk → `{{system}}`/`{{tools}}`/`{{messagePrefix}}` outside each pin, structure kept — [pinned-header Agent Note](../../../.agents/notes/archived/testing/2026-07-06-pin-request-header-content-in-one-scenario.md)), and `stabilizeFixtureMessageIds` (committed UUIDs carried into unchanged, mutually unique messages by structurally rewriting only complete surface and durable-inbox message ID fields across any recorder's fixture-ready parent/child logs).
- **`defineAcpSnapshotSuite` (factory)** — registers the whole describe/it tree for a scenario table: per-scenario expected-output and re-persisted-log comparisons, record/refresh fixture write-back, rejection of structured `UNKNOWN_TOOL` results, a tokenized pin per header class composed with independently shared `system-prompt.expected.md` and `tool-schemas.expected.json` sidecars, and a live uniformity guard. Its fixture guards reject orphan scenario dirs, missing files, multiple pins for one class, duplicate sidecar content, noncanonical macOS-prefixed cwd tokens, unscrubbed JSONL headers, and malformed pinning headers. Before record or refresh writes fixtures, an unchanged complete message retains its committed UUID only when both its ID and identity-free fingerprint are unique across the scenario's fixture-ready parent/child logs; the session package's authoritative surface-type predicate selects surface carriers, correlated `agent/inbox/spliced` copies join the same mapping, and only validated `id` fields in those carriers are rewritten. New, changed, malformed, and graph-ambiguous messages keep fresh UUIDs. Refresh evaluates fresh leaves with the harvested run's ids, cwd, and every cwd alias, then reuses normalized-equivalent leaves only when the complete logical-record layout aligns and volatile string replacements form a bijection; complete message IDs in surface or inbox carriers are excluded because the later structural pass owns them, ambiguous logs keep fresh strings, and fresh semantic values remain authoritative. It also expands packed timing envelopes before aligning event times, so switching between packed and unpacked layouts cannot shift later records. A newly inserted `session/title` receives its preceding event's time so feature-driven insertions do not churn the remainder of a fixture. Each scenario directory's `session.jsonl` plus contiguous `session.<n>.jsonl` siblings are the ordered primary/child inventory; the scenario table does not duplicate their count. Must be called at vitest collection time.

Committed session fixtures retain their complete session header and event payloads but omit ordinary `seq`/`time` and packed-row `seq0`/`time0` envelopes. Replay synthesizes those envelopes in memory; runtime persistence remains unchanged. Fixtures also use canonical packed rows; the [temporary repository migrator](../../../scripts/migrate-packed-session-fixtures.ts) (`pnpm run migrate:packed-session-fixtures`) rewrites older fixture layouts, and its [removal proposal](../../../.agents/notes/proposed/process/2026-07-26-remove-packed-session-fixture-migrator.md) owns its deletion.

A consuming `*.snapshot.ts` is the scenario table plus one factory call:

```ts
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineAcpSnapshotSuite,
  type Scenario,
  type SnapshotSuiteOptions,
} from '@deepseek-ai/dsh-session-snapshot'

function snapshotMode(value: string | undefined): SnapshotSuiteOptions['mode'] {
  switch (value) {
    case undefined:
    case '':
    case 'replay': return 'replay'
    case 'record': return 'record'
    case 'refresh': return 'refresh'
    default: throw new Error(`unknown DSH_SNAPSHOT mode: ${value}`)
  }
}

const SCENARIOS: Scenario[] = [
  { name: 'text-turn', hasModelTurn: true, recorded: true, pinsHeader: true },
]

defineAcpSnapshotSuite({
  agent: { // absolute paths, resolved from the suite's own location
    binScript: fileURLToPath(new URL('../../../apps/cli/src/bin.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
    profile: 'acp',
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  },
  snapshotsDir: join(dirname(fileURLToPath(import.meta.url)), 'snapshots'),
  scenarios: SCENARIOS, // exactly one entry per header class sets pinsHeader
  mode: snapshotMode(process.env.DSH_SNAPSHOT),
})
```

A scenario booting a differently composed profile sets its own `configPath` patch (its basename still ends in `cordis.yml`, so the launcher finds the sibling `*cordis.snapshot.yml`) and, when that composition changes the request header, its own `headerClass` with its own pinning scenario; the top-level profile corpora contain the current templates. Default generated workspaces are stored in session fixtures as `{{cwd}}` so platform temp roots and random basenames do not affect recordings; `workspaceParent` moves the generated cwd outside the platform temp area when temporary-directory grants are themselves under test, keeps that explicit path in the fixture, and remains parent-owned while the harness removes only the generated child. A scenario's committed `workspace/` is copied into that child first, then `prepareWorkspace` runs against the generated cwd before the agent starts. Reserve this hook for fixtures Git cannot represent portably, keep ordinary seeds in `workspace/`, and pair it with `posixOnly` when the generated paths are invalid on Windows.

A pin owns its generated `system-prompt.expected.md` or `tool-schemas.expected.json` by default; `systemPromptSource` and `toolSchemasSource` name another pin when the complete corresponding sequence is identical, so each distinct version is committed once. The pin's `session.jsonl` stores `"system":"{{system}}","tools":"{{tools}}"` while retaining config, reason, and any model-visible prefix. A pin with legitimate mid-run header changes declares `expectedHeaderChanges`; a shared source must declare the same count, and record/refresh rejects claimants that generate different bytes.

A child session whose own scope composes a different request declares it per fixture index: `pinsChildToolSchemas` moves that child's tool sequence into `tool-schemas.<n>.expected.json`, and `pinsChildSystemPrompts` moves its prompt into `system-prompt.<n>.expected.md`. Each names the `session.<n>.jsonl` fixture it describes, leaves every other request-header field to the class pin, and requires its sidecar to exist exactly when declared. A child prompt sidecar must also differ from its class pin, so a redundant copy fails instead of drifting. A continuable child carrying the scope-local `report` tool and its guidance section is the shipped case for both.

Every scenario compares `stdout.expected.jsonl` with cwd-rooted separators canonicalized to `/`. On Windows, `pinsNativeWindowsStdout` additionally compares the complete `stdout.expected.windows.jsonl` after the shared expected output and requires that sidecar exactly when enabled. A scenario requiring a non-Windows host declares `posixOnly`, which skips its run test on Windows while the fixture guards keep covering its committed files everywhere; examples include POSIX process semantics (e.g. cancelling a live bash call kills a detached process group) and generated paths Windows cannot represent. A scenario whose composition needs a usable `pwsh` declares `pwshOnly`; the caller-supplied `hasPwsh` probe (the shipped acp-agent suite follows the executor's own resolution, so Program Files installs count) skips the run test when no usable `pwsh` resolves while the fixture guards keep covering its committed files everywhere.

Each composition owner ships a `cordis.snapshot.yml` replay patch next to its live patch. The launcher applies the live base patch and the selected replay sibling under `DSH_SNAPSHOT=replay` ([single-source replay config Agent Note](../../../.agents/notes/archived/testing/2026-07-04-single-source-acp-replay-config.md)); [`dsh-llm-replay`](../llm-replay/README.md) serves fixtures named by the `DSH_SNAPSHOT_*` environment values. `pnpm run test:snapshot:record` calls the live LLM and rewrites the recorded scenarios' model fixtures; `pnpm run test:snapshot:refresh` stays keyless, runs the replay patch, and rewrites stdout, comparable session-log expected outputs, and owned prompt and tool-schema sidecars from the committed model scripts. Fixture roles, record/replay/refresh semantics, and scenario-table fields are documented on `Scenario` and in the [snapshot Agent Note](../../../.agents/notes/implemented/testing/2026-06-19-acp-snapshot-tests.md).

Constraints: `suite.ts` and `harness.ts` import vitest (the harness polls its durable-boundary waits through `vi.waitFor`), so the package entry is importable only inside a vitest run (the launcher and normalizers have no such dependency but ship from the same entry). The launcher and suite factory are ACP-specific by design — the launcher speaks the SDK's `ClientSideConnection` — while the normalizers are transport-neutral session-log/text helpers also consumed by the JSON-RPC and Web snapshot recorders. Input scripts cover initialization, fresh-session creation, shorthand text prompts, exact structured ACP prompt blocks, cancellation, expected RPC failures, and durable turn-boundary waits. Permission round-trips are a FIFO queue of option-kind selections (`allow_once`, `reject_once`, …) mapped to the agent-issued `optionId`; an absent or exhausted queue answers `cancelled`, and an unoffered kind rejects the run.

## Model Experience

None, as this test-only support records, normalizes, and compares profile sessions without changing the agent's assembled model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Session harvest requires raw JSONL mode** — `runScenario` collects persisted `.jsonl` logs, so snapshot configs set `persistenceCompression: 'none'`; compressed JSONL and SQLite compositions have no snapshot-harvest path.
- **Built mode requires current artifacts** — run `pnpm run build` before selecting `DSH_EXAMPLE_MODE=lib`; source mode remains the zero-build path.
- **ACP remains for protocol behavior** — cancellation and permission round trips whose stimulus is the ACP client stay on that adapter; assembled one-shot and persistent-control behavior uses headless and SDK instead.
