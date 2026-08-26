/**
 * SubmitMachine: the pure per-session submit-plane state machine.
 * Events in, effects out; zero React / DOM / cordis. Package-private — the
 * SessionInput shell is the only caller and the sole executor of the
 * returned effects.
 *
 * The machine owns phase, claim, and the in-flight SubmitAttempt; it never
 * holds the draft. Text truth lives in the shell's Lexical editor, and every
 * decision that needs the draft reads it from the event payload (claim
 * integrity watch, enter snapshots, settlement suffix/re-entry decisions).
 */
import type { InputSubmitMode } from '../contract/composer-submission.ts'
import type { CommandClaim, InputEffect, InputEvent, InputState, SubmitAttempt } from '../contract/input.ts'

/** Exhaustiveness backstop for the closed InputEvent union. */
function unreachable(value: never): never {
  throw new Error(`unreachable input event: ${JSON.stringify(value)}`)
}

/**
 * Strip the claim token off a draft to yield submit args. Leading whitespace
 * (incl. newlines — leading-trigger trim) is tolerated; a bare `/name`
 * missing the token's trailing separator yields empty args. Exactly one
 * separator char is consumed; the remainder — newlines included — stays
 * verbatim (`/goal x\ny` → `x\ny`).
 */
function argsAfter(draft: string, token: string): string {
  const s = draft.trimStart()
  if (s.startsWith(token)) return s.slice(token.length)
  const base = token.trimEnd()
  if (s.startsWith(base)) {
    const rest = s.slice(base.length)
    return /^\s/.test(rest) ? rest.slice(1) : rest
  }
  return ''
}

/** The submit-plane slice of the published InputState. */
export interface SubmitSnapshot {
  readonly phase: InputState['phase']
  readonly claim?: InputState['claim']
}

/**
 * Pure submit machine, one instance per session (per-session isolation is by
 * construction). The machine constructs one AbortController per SubmitAttempt
 * at enter time and aborts it itself on release; the shell never aborts, it
 * only observes attempt.signal on its adjudicate/submit promises. Stale
 * attempts (any adjudicated / adjudication-failed / submit-settled whose seq
 * is not the in-flight one) are dropped: same state, zero effects.
 */
export class SubmitMachine {
  private phase: InputState['phase'] = 'plain'
  private claim: CommandClaim | undefined
  private seq = 0
  private inflight: {
    readonly attempt: SubmitAttempt
    readonly controller: AbortController
  } | undefined

  /** Read-only snapshot of the submit-plane state. */
  get state(): SubmitSnapshot {
    const c = this.claim
    return {
      phase: this.phase,
      ...(c
        ? {
          claim: {
            token: c.token,
            ...(c.hint !== undefined ? { hint: c.hint } : {}),
            ...(c.images === true ? { images: true } : {}),
          },
        }
        : {}),
    }
  }

  /**
   * Feed one event through the machine.
   * @param ev - Input event; the single write path for all submit-plane state.
   * @returns Effects for the shell to execute in order; empty on no-ops, locks, and dropped stale events.
   */
  dispatch(ev: InputEvent): readonly InputEffect[] {
    switch (ev.type) {
      case 'draft-changed': return this.onDraftChanged(ev.draft)
      case 'claim': return this.onClaim(ev.claim)
      case 'enter': return this.onEnter(ev.mode, ev.draft)
      case 'adjudicated': return this.onAdjudicated(ev.attempt, ev.outcome)
      case 'adjudication-failed': return this.onAdjudicationFailed(ev.attempt, ev.message)
      case 'submit-settled': return this.onSubmitSettled(ev)
      case 'send-committed': return this.onSendCommitted()
      case 'release': return this.onRelease()
      default: return unreachable(ev)
    }
  }

  /** Claimed integrity watch: any draft that breaks the token prefix releases the claim. */
  private onDraftChanged(draft: string): InputEffect[] {
    if (this.phase === 'claimed' && this.claim !== undefined && !draft.startsWith(this.claim.token)) {
      this.phase = 'plain'
      this.claim = undefined
    }
    return []
  }

  /** The editor applied a claim-token replacement: enter claimed (busy phases refuse). */
  private onClaim(claim: CommandClaim): InputEffect[] {
    if (this.phase !== 'plain' && this.phase !== 'claimed') return []
    this.claim = claim
    this.phase = 'claimed'
    return []
  }

  // ---- submit plane ----

  /** Mint the next SubmitAttempt and take the in-flight slot. */
  private beginAttempt(mode: InputSubmitMode, draft: string): SubmitAttempt {
    const controller = new AbortController()
    this.seq += 1
    const attempt: SubmitAttempt = { seq: this.seq, signal: controller.signal, draftSnapshot: draft, mode }
    this.inflight = { attempt, controller }
    return attempt
  }

  private onEnter(mode: InputSubmitMode, draft: string): InputEffect[] {
    if (this.phase === 'adjudicating' || this.phase === 'submitting') return []
    if (this.phase === 'claimed' && this.claim !== undefined) {
      const attempt = this.beginAttempt(mode, draft)
      this.phase = 'submitting'
      return [{ type: 'begin-submit', attempt, claim: this.claim, args: argsAfter(draft, this.claim.token) }]
    }
    const trimmed = draft.trim()
    if (trimmed === '') return []
    if (trimmed.startsWith('/')) {
      const attempt = this.beginAttempt(mode, draft)
      this.phase = 'adjudicating'
      return [{ type: 'adjudicate', attempt, draft }]
    }
    const attempt = this.beginAttempt(mode, draft)
    this.phase = 'submitting'
    return [{ type: 'default-sink', attempt, draft, mode }]
  }

  private onAdjudicated(attempt: SubmitAttempt, outcome: Extract<InputEvent, { type: 'adjudicated' }>['outcome']): InputEffect[] {
    const flight = this.inflight
    if (this.phase !== 'adjudicating' || flight === undefined || flight.attempt.seq !== attempt.seq) return []
    if (outcome !== undefined && outcome !== 'handled' && 'claim' in outcome) {
      this.claim = outcome.claim
      this.phase = 'submitting'
      return [{
        type: 'begin-submit',
        attempt,
        claim: outcome.claim,
        args: argsAfter(attempt.draftSnapshot, outcome.claim.token),
      }]
    }
    // 'handled' (source dealt internally), {insert}/{text} (no enter-time span
    // semantics), or a miss: all land plain; only the miss flows to the sink.
    if (outcome === undefined) {
      this.phase = 'submitting'
      return [{
        type: 'default-sink',
        attempt,
        draft: attempt.draftSnapshot,
        mode: attempt.mode,
      }]
    }
    this.inflight = undefined
    this.phase = 'plain'
    return []
  }

  private onAdjudicationFailed(attempt: SubmitAttempt, message: string): InputEffect[] {
    if (this.phase !== 'adjudicating' || this.inflight?.attempt.seq !== attempt.seq) return []
    this.inflight = undefined
    this.phase = 'plain'
    // Draft retained: warmup failure never silently downgrades to a prompt.
    return [{ type: 'notice', level: 'error', text: message }]
  }

  private onSubmitSettled(ev: Extract<InputEvent, { type: 'submit-settled' }>): InputEffect[] {
    const flight = this.inflight
    if (this.phase !== 'submitting' || flight === undefined || flight.attempt.seq !== ev.attempt.seq) return []
    this.inflight = undefined
    if (ev.ok) {
      this.phase = 'plain'
      this.claim = undefined
      const effects: InputEffect[] = [{ type: 'commit-draft', retainSuffixOf: flight.attempt.draftSnapshot }]
      if (ev.outcome?.text !== undefined) {
        effects.push({ type: 'notice', level: ev.outcome.kind === 'error' ? 'error' : 'info', text: ev.outcome.text })
      }
      return effects
    }
    const text = ev.message ?? ev.outcome?.text
    // Keep the same command claim only while the live draft still equals the
    // enter-time draft; user input typed during flight wins.
    // Claimed re-entry additionally requires the watch to hold — an
    // enter-path snapshot may carry leading whitespace the token never had.
    if (ev.draft === flight.attempt.draftSnapshot
      && this.claim !== undefined && ev.draft.startsWith(this.claim.token)) {
      this.phase = 'claimed'
      return text === undefined ? [] : [{ type: 'notice', level: 'error', text }]
    }
    this.phase = 'plain'
    this.claim = undefined
    return text === undefined ? [] : [{ type: 'notice', level: 'error', text }]
  }

  /** Clear the draft after an accepted image-only send (no suffix retention: there was no draft). */
  private onSendCommitted(): InputEffect[] {
    if (this.phase !== 'plain') return []
    this.claim = undefined
    return [{ type: 'commit-draft', retainSuffixOf: null }]
  }

  private onRelease(): InputEffect[] {
    if (this.inflight !== undefined) {
      this.inflight.controller.abort()
      this.inflight = undefined
    }
    this.phase = 'plain'
    this.claim = undefined
    return []
  }
}
