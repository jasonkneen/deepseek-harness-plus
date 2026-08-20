/**
 * Process plumbing for the local subprocess service: detached process-tree
 * spawn with per-stream stdio dispositions, tail-keep collection with spill
 * files, tree-scoped signalling (POSIX groups; Windows taskkill), and the
 * SIGTERM→SIGKILL escalation. This layer reacts to an abort signal; callers
 * own deadlines, teardown ladders, and cause classification.
 * @module dsh-subprocess-local/spawn
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import type { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleepMs } from 'node:timers/promises'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {
  CollectedOutput,
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { BoundProcessOwner, ManagedProcessLaunch } from './managed-owner.ts'
import { observeChildClose, waitWithAbort } from './managed-owner.ts'
import { linuxProcessGroupHasLiveMembers } from './process-inspector.ts'

/**
 * Build a child environment: explicit caller entries override the scrubbed
 * parent base using the target platform's environment-key semantics. A string
 * deliberately restores or overrides an entry; an explicit `undefined`
 * tombstone removes an ordinary ambient entry.
 * @param extra - explicit caller entries and tombstones, merged after the scrub.
 * @returns the environment to hand to `spawn` for the child process.
 */
export function childEnv(extra?: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const env = scrubbedParentEnv()
  if (process.platform !== 'win32') return { ...env, ...extra }
  let entries: [string, string | undefined][] = Object.entries(env)
  for (const [key, value] of Object.entries(extra ?? {})) {
    const normalized = key.toUpperCase()
    entries = entries.filter(([inherited]) => inherited.toUpperCase() !== normalized)
    entries.push([key, value])
  }
  return Object.fromEntries(entries)
}

/** Injectable knobs so tests can exercise spill and platform behavior deterministically. */
export interface SpawnInternals {
  /** Directory for spill files (defaults to the OS temp dir). */
  spillDir?: string
  /** Windows tree-termination runner (defaults to `taskkill /PID <pid> /T /F`). */
  taskkill?: (pid: number) => void
  /** Host platform override for signalling decisions. */
  platform?: NodeJS.Platform
  /** Linux process-group member probe (defaults to `/proc` inspection). */
  linuxProcessGroupHasLiveMembers?: (processGroupId: number) => boolean | undefined
}

/**
 * Local-only synchronous final termination used by the owning service during
 * host exit and as the last fallback after failed normal disposal. It is
 * intentionally absent from the public subprocess seam.
 */
export interface LocalSubprocessHandle extends SubprocessHandle {
  /** Force-terminate the current tree synchronously without starting timers or waits. */
  terminateForHostExit(): void
}

/**
 * Liveness-poll cadence for tree-exit waits. The timer stays ref'd: an
 * awaited teardown must keep the event loop alive until the tree really
 * exits, or the parent can exit while claiming quiescence and orphan the
 * survivors it promised to reap.
 */
function sleepTick(): Promise<void> {
  return sleepMs(15)
}

let spillCounter = 0
let defaultSpillDir: string | undefined

/**
 * The default spill location: a private (0700) per-process directory under
 * the OS tmpdir, created lazily. Predictable world-readable paths would let
 * other local users read command output or pre-create symlinks.
 */
function privateSpillDir(): string {
  defaultSpillDir ??= mkdtempSync(join(tmpdir(), 'dsh-subprocess-'))
  return defaultSpillDir
}

/**
 * Collects one stream with a bounded in-memory tail. With a spill cap, on
 * first overflow a spill file is created and every chunk (including those
 * already collected) is appended there while the full stream remains within
 * the cap; without one, only the in-memory tail is ever retained (the
 * diagnostic-tail shape — a language server's stderr).
 *
 * Tail-keep rationale (pi/OpenCode): errors and final results cluster at the
 * end of command output; the spill file covers the head.
 */
export class OutputCollector {
  private chunks: Buffer[] = []
  private bytes = 0
  private dropped = false
  private spillFd: number | undefined
  private spillFile: string | undefined
  private spillDisabled: boolean
  /** Total bytes ever pushed (not just retained). */
  private total = 0

  constructor(
    private readonly maxBytes: number,
    private readonly maxSpillBytes: number | undefined,
    private readonly label: string,
    private readonly spillDir: string,
  ) {
    this.spillDisabled = maxSpillBytes === undefined
  }

  /**
   * Ingest one stream chunk, counting it toward the whole-stream total. On
   * first overflow of the in-memory cap a spill file is opened (when spilling
   * is enabled) and every chunk (already-collected ones included) is appended
   * there from then on; the in-memory tail then drops whole chunks from its
   * head (or the head of a single over-cap chunk) until it fits the cap again.
   * @param chunk - the raw bytes from one stream 'data' event.
   */
  push(chunk: Buffer): void {
    this.total += chunk.length
    const overflows = this.bytes + chunk.length > this.maxBytes
    if (!this.spillDisabled && (overflows || this.spillFd !== undefined)) this.spillAll(chunk)
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0] as Buffer
      const excess = this.bytes - this.maxBytes
      if (head.length <= excess) {
        // Drop the whole head chunk (length ≥ 1 is guaranteed while over cap).
        this.chunks.shift()
        this.bytes -= head.length
      } else {
        // Trim the head so the retained window is byte-exact at the cap — a
        // diagnostic tail (an LSP server's stderr) must hold the LAST
        // maxBytes regardless of how the stream was chunked.
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
      }
      this.dropped = true
    }
  }

  /** Open the spill file lazily and append `chunk` (and any prior chunks once). */
  private spillAll(chunk: Buffer): void {
    if (this.maxSpillBytes !== undefined && this.total > this.maxSpillBytes) {
      this.discardSpill()
      return
    }
    if (this.spillFd === undefined) {
      // Random suffix + O_EXCL + no-follow-equivalent ('wx' fails on any
      // existing path, symlink or not) + owner-only mode: defeats spill-path
      // prediction and symlink planting in shared tmp dirs.
      this.spillFile = join(
        this.spillDir,
        `dsh-subprocess-${process.pid}-${++spillCounter}-${randomBytes(6).toString('hex')}-${this.label}.log`,
      )
      this.spillFd = openSync(this.spillFile, 'wx', 0o600)
      for (const prior of this.chunks) writeSync(this.spillFd, prior)
    }
    writeSync(this.spillFd, chunk)
  }

  /** Stop spilling and remove the file once it can no longer hold the complete stream. */
  private discardSpill(): void {
    const fd = this.spillFd
    const file = this.spillFile
    this.spillFd = undefined
    this.spillFile = undefined
    this.spillDisabled = true
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Retain the descriptor so finalize can retry the failed close.
        this.spillFd = fd
      }
    }
    if (file !== undefined) {
      try {
        unlinkSync(file)
      } catch {
        // A failed unlink leaves at most maxSpillBytes behind, never an unbounded file.
      }
    }
  }

  /**
   * Incremental read in whole-stream byte coordinates: returns everything
   * pushed since `fromByte`. When `fromByte` has already slid out of the
   * in-memory tail window, the read is `lossy` — it returns the whole
   * retained tail and the gap is only recoverable from the spill file.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 for the first read).
   * @returns the delta text, the offset for the next read, the `lossy` flag, and the spill path when one was created.
   */
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } {
    const windowStart = this.total - this.bytes
    const buffer = Buffer.concat(this.chunks)
    const lossy = fromByte < windowStart
    const slice = lossy ? buffer : buffer.subarray(fromByte - windowStart)
    return {
      text: slice.toString('utf8'),
      nextOffset: this.total,
      lossy,
      ...this.spillFile !== undefined ? { spillPath: this.spillFile } : {},
    }
  }

  /**
   * Close the spill file once the stream has ended. A failed close (delayed
   * writeback fault) stops advertising the spill path — the file may be
   * missing its tail — while every in-memory read keeps working. Idempotent;
   * the spawn path seals both collectors at settlement so reads after exit
   * never point at a still-open file.
   */
  seal(): void {
    if (this.spillFd === undefined) return
    try {
      closeSync(this.spillFd)
    } catch {
      // A delayed writeback failure makes the spill unreliable; keep the
      // in-memory result but stop advertising that file.
      this.spillFile = undefined
    }
    this.spillFd = undefined
  }

  /**
   * Seal the spill file and return the final output.
   * @returns the final collected output: tail text, truncation flag, and the spill path when intact.
   */
  finalize(): CollectedOutput {
    this.seal()
    return {
      text: Buffer.concat(this.chunks).toString('utf8'),
      truncated: this.dropped,
      ...this.spillFile !== undefined ? { spillPath: this.spillFile } : {},
    }
  }
}

/**
 * Send `sig` to a detached POSIX process group. Never throws: delivery races
 * process exit and may run in a timer callback, so failures are contained and
 * a non-positive pid is a no-op.
 * @param pid - the group leader's pid; non-positive means the spawn failed and the call is a no-op.
 * @param sig - the signal to deliver to the whole group.
 */
export function killGroup(pid: number, sig: NodeJS.Signals): void {
  if (pid <= 0) return
  try {
    process.kill(-pid, sig)
  } catch {
    // Swallow: see contract above.
  }
}

/**
 * Terminate one Windows process tree with `taskkill /T /F`. Contained like
 * POSIX group signalling — delivery races tree exit, so an absent tree, a
 * nonzero status, or a missing taskkill binary must not break idempotent
 * teardown.
 * @param pid - root process id; non-positive is a no-op.
 */
export function taskkillProcessTree(pid: number): void {
  if (pid <= 0) return
  // Outcome deliberately unchecked: an already-absent tree (status 128), exit
  // races, and a missing taskkill binary (spawnSync reports, never throws) are
  // as tolerable here as ESRCH is for a POSIX group signal.
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

/**
 * Signal a detached process tree with platform-correct semantics: POSIX
 * signals the negative process-group id and falls back to the direct child
 * when the group is gone; Windows terminates the tree via taskkill (any
 * signal value force-terminates — Node maps signals to TerminateProcess).
 */
function signalTree(
  platform: NodeJS.Platform,
  pid: number,
  sig: NodeJS.Signals,
  child: ChildProcess,
  taskkill: (pid: number) => void,
): void {
  if (platform === 'win32') {
    taskkill(pid)
    return
  }
  /* v8 ignore next -- kill/terminate gate on treeAlive(), which is false for pid -1; this guard protects direct callers only. */
  if (pid <= 0) return
  try {
    process.kill(-pid, sig)
  } catch {
    /* v8 ignore start -- the fallback needs a live child whose group signal fails
       (EPERM-style), which POSIX CI cannot stage; the swallow keeps teardown idempotent. */
    try {
      child.kill(sig)
    } catch {
      // The direct child already exited; teardown remains idempotent.
    }
    /* v8 ignore stop */
  }
}

/**
 * Validate the synchronous portion of one ordinary spawn request.
 * @param spec - exact target request.
 * @throws when grace, cancellation, or argv is invalid before launch.
 */
export function validateSubprocessSpec(spec: SubprocessSpawnSpec): void {
  if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (spec.signal?.aborted) {
    throw new Error(`aborted before spawn: ${String(spec.signal.reason ?? 'aborted')}`)
  }
  const [program] = spec.argv
  if (program === undefined || program.length === 0) {
    throw new Error('invalid argv: expected a non-empty program name at argv[0]')
  }
}

function directChildResult(child: ChildProcess): Promise<SubprocessOutcome> {
  return new Promise((resolve, reject) => {
    let completed = false
    child.once('error', (error) => {
      if (completed) return
      completed = true
      reject(error instanceof Error ? error : new Error(String(error)))
    })
    child.once('exit', (exitCode, signal) => {
      if (completed) return
      completed = true
      resolve({ exitCode, signal })
    })
  })
}

function fallbackOwner(
  platform: NodeJS.Platform,
  pid: number,
  child: ChildProcess,
  taskkill: (pid: number) => void,
  linuxGroupHasLiveMembers: (processGroupId: number) => boolean | undefined,
  direct: Promise<SubprocessOutcome>,
): BoundProcessOwner {
  let stopped = false
  let directSettled = false
  let observation: Promise<void> | undefined
  void direct.then(
    () => { directSettled = true },
    () => { directSettled = true },
  )

  const alive = (): boolean => {
    if (stopped || pid <= 0) return false
    if (platform === 'win32') return child.exitCode === null && child.signalCode === null
    try {
      process.kill(-pid, 0)
      if (directSettled && platform === 'linux' && linuxGroupHasLiveMembers(pid) === false) return false
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return false
      /* v8 ignore start -- EPERM and non-POSIX negative-pid failures are platform defenses. */
      if (code === 'EPERM') return true
      return child.exitCode === null && child.signalCode === null
      /* v8 ignore stop */
    }
  }

  return {
    signal: (signal) => {
      if (!alive()) {
        stopped = true
        return
      }
      signalTree(platform, pid, signal, child, taskkill)
    },
    waitForExit: async (signal) => {
      if (stopped) return true
      observation ??= (async () => {
        while (alive()) await sleepTick()
        stopped = true
      })()
      return waitWithAbort(observation, signal)
    },
  }
}

/**
 * Bind platform launch facts to the existing stdio, outcome, abort, and escalation lifecycle.
 * @param spec - fully resolved argv, cwd, stdio, grace, cancellation, environment.
 * @param launch - platform child streams, direct outcome, and managed-range owner.
 * @param internals - test-only spill-directory override.
 * @returns live subprocess handle.
 */
export function bindManagedProcess(
  spec: SubprocessSpawnSpec,
  launch: ManagedProcessLaunch,
  internals: Pick<SpawnInternals, 'spillDir'> = {},
): LocalSubprocessHandle {
  validateSubprocessSpec(spec)
  const spillDir = internals.spillDir ?? privateSpillDir()
  const child = launch.child

  const isCollect = (mode: SubprocessOutputMode): mode is SubprocessCollect =>
    mode !== 'pipe' && mode !== 'inherit'
  const outMode = spec.stdio.stdout
  const errMode = spec.stdio.stderr
  const stdinMode = spec.stdio.stdin

  const collectStream = (mode: SubprocessOutputMode, stream: Readable | null, label: string): OutputCollector | undefined => {
    if (!isCollect(mode) || stream === null) return undefined
    const collector = new OutputCollector(mode.maxBytes, mode.spill?.maxBytes, label, spillDir)
    stream.on('data', (chunk: Buffer) => { collector.push(chunk) })
    return collector
  }
  const stdoutCollector = collectStream(outMode, child.stdout, 'stdout')
  const stderrCollector = collectStream(errMode, child.stderr, 'stderr')

  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let rangeExitObserved = false
  let rangeExitObservation: Promise<void> | undefined
  let settled = false

  /**
   * Start or reuse the handle's single managed-range exit observer. The first
   * confirmed absence is a permanent no-more-signals boundary: it cancels a
   * pending escalation before a stale platform identity can be reused.
   */
  const observeRangeExit = (): Promise<void> => {
    rangeExitObservation ??= (async () => {
      await launch.owner.waitForExit()
      rangeExitObserved = true
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      graceTimer = undefined
    })()
    return rangeExitObservation
  }

  const kill = (sig: NodeJS.Signals): void => {
    if (rangeExitObserved) return
    launch.owner.signal(sig)
  }

  const terminate = (): void => {
    if (rangeExitObserved || graceTimer !== undefined) return
    void observeRangeExit()
    kill('SIGTERM')
    graceTimer = setTimeout(() => { kill('SIGKILL') }, spec.graceMs)
  }

  const terminateForHostExit = (): void => {
    kill('SIGKILL')
  }

  // The caller owns timeout classification; this layer only reacts to abort.
  const onAbort = (): void => { terminate() }
  spec.signal?.addEventListener('abort', onAbort, { once: true })

  // Batch stdin is written and closed up front; process exit and captured
  // output remain authoritative, so write errors (EPIPE) are best-effort.
  if (typeof stdinMode === 'object' && child.stdin !== null) {
    child.stdin.on('error', () => { /* stdin write is best-effort; outcome rides on exit/output. */ })
    child.stdin.end(stdinMode.data)
  }

  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    let pipeDrainTimer: ReturnType<typeof setTimeout> | undefined
    let directOutcome: SubprocessOutcome | undefined
    let wrapperClosed = false
    const settle = (outcome: SubprocessOutcome): void => {
      if (settled) return
      settled = true
      // Only harness-collected pipes are force-closed at the drain boundary;
      // a 'pipe'-mode stream belongs to the caller and closes with the child.
      if (stdoutCollector !== undefined) child.stdout?.destroy()
      if (stderrCollector !== undefined) child.stderr?.destroy()
      stdoutCollector?.seal()
      stderrCollector?.seal()
      cleanup()
      resolve(outcome)
    }
    launch.direct.then((outcome) => {
      directOutcome = outcome
      pipeDrainTimer = setTimeout(() => { settle(outcome) }, spec.graceMs)
      if (wrapperClosed) settle(outcome)
    }, (error: unknown) => {
      if (settled) return
      settled = true
      stdoutCollector?.seal()
      stderrCollector?.seal()
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    })
    void launch.closed.then(() => {
      wrapperClosed = true
      if (directOutcome !== undefined) settle(directOutcome)
    })
    function cleanup(): void {
      // graceTimer deliberately NOT cleared: the SIGKILL escalation must be
      // able to reach tree survivors after the direct child settles.
      if (pipeDrainTimer !== undefined) clearTimeout(pipeDrainTimer)
      spec.signal?.removeEventListener('abort', onAbort)
    }
  })

  const waitForExit = async (signal?: AbortSignal): Promise<boolean> => {
    if (rangeExitObserved) return true
    return waitWithAbort(observeRangeExit(), signal)
  }

  return {
    pid: launch.pid,
    /* v8 ignore start -- pipe-mode fds exist on every spawn Node returns; the null-coalesces guard a nonconforming ChildProcess only. */
    stdin: stdinMode === 'pipe' ? child.stdin ?? undefined : undefined,
    stdout: outMode === 'pipe' ? child.stdout ?? undefined : undefined,
    stderr: errMode === 'pipe' ? child.stderr ?? undefined : undefined,
    /* v8 ignore stop */
    collected: {
      ...stdoutCollector !== undefined ? { stdout: stdoutCollector } : {},
      ...stderrCollector !== undefined ? { stderr: stderrCollector } : {},
    },
    done,
    terminate,
    terminateForHostExit,
    waitForExit,
  }
}

/**
 * Spawn one detached PGID/taskkill fallback and bind the common lifecycle.
 * @param spec - fully resolved argv, cwd, stdio, grace, cancellation, environment.
 * @param internals - test-only spill-directory, platform, and taskkill overrides.
 * @returns live subprocess handle.
 */
export function spawnSubprocess(spec: SubprocessSpawnSpec, internals: SpawnInternals = {}): LocalSubprocessHandle {
  validateSubprocessSpec(spec)
  const platform = internals.platform ?? process.platform
  const [program, ...args] = spec.argv
  const child = spawn(program as string, args, {
    cwd: spec.cwd,
    env: childEnv(spec.env),
    stdio: [
      spec.stdio.stdin === 'ignore' ? 'ignore' : 'pipe',
      spec.stdio.stdout === 'inherit' ? 'inherit' : 'pipe',
      spec.stdio.stderr === 'inherit' ? 'inherit' : 'pipe',
    ],
    detached: platform !== 'win32',
  })
  const closed = observeChildClose(child)
  const direct = directChildResult(child)
  const pid = child.pid ?? -1
  const owner = fallbackOwner(
    platform,
    pid,
    child,
    internals.taskkill ?? taskkillProcessTree,
    internals.linuxProcessGroupHasLiveMembers ?? linuxProcessGroupHasLiveMembers,
    direct,
  )
  return bindManagedProcess(spec, { child, pid, direct, closed, owner }, internals)
}
