/**
 * Frozen input-machine contract. Types
 * only. Three-tier visibility: business packages see InputState via the
 * InputZone currency; the scoped input events carry the mutation verbs; the
 * conversation wiring layer alone sees the full SessionInput. InputMachine
 * (machine.ts) is package-private and never exported.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { QueueRow } from './queue.ts'
import type { InputSubmitMode } from './composer-submission.ts'

/** Pick-time draft span guarded by the input revision. */
export interface TokenSpan {
  readonly start: number
  readonly end: number
  readonly draftRev: number
}

/** Base64 image payload passed to a claimed command submission. */
export interface SubmitImageAttachment {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly data: string
  readonly name?: string
}

/** Settled result of a command or default composer submission. */
export interface SubmitOutcome {
  readonly kind: 'success' | 'error'
  readonly text?: string
}

/** Command-mode credential supplied by one input-trigger source. */
export interface CommandClaim {
  readonly token: string
  readonly hint?: string
  readonly images?: boolean
  /**
   * Submit the claimed command.
   * @param args - command text after the claimed token.
   * @param actx - current Session scope.
   * @param images - serialized draft images accepted by the claim.
   * @returns command settlement.
   */
  submit(args: string, actx: Context, images: readonly SubmitImageAttachment[]): Promise<SubmitOutcome>
}

/** Structured reference inserted by an input-trigger source. */
export interface ReferenceInsert {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: 'session' | 'file' | 'folder'
  readonly clipboardText: string
}

/** Result of trigger-source adjudication. */
export type PickOutcome =
  | { readonly claim: CommandClaim }
  | { readonly insert: ReferenceInsert }
  | { readonly text: string; readonly continue?: boolean }
  | 'handled'
  | undefined

/** Keyboard keys intercepted by an open trigger menu. */
export type ArbitrateKey = 'up' | 'down' | 'enter' | 'escape'

/** Trigger-menu keyboard routing result. */
export type ArbitrateOutcome = 'consumed' | 'pick-highlighted' | 'pass'

/** Scoped request to enter command mode. */
export interface BeginCommandRequest {
  readonly claim: CommandClaim
  readonly span: TokenSpan
}

/** Scoped request to insert a structured reference. */
export interface InsertReferenceRequest {
  readonly reference: ReferenceInsert
  readonly span: TokenSpan
}

/** Scoped request to consume a command token after business settlement. */
export interface ConsumeTokenRequest {
  readonly guard:
    | { readonly kind: 'span'; readonly span: TokenSpan }
    | { readonly kind: 'bare-token'; readonly token: string }
}

/** Scoped request to insert ordinary completion text. */
export interface InsertTextRequest {
  readonly text: string
  readonly span: TokenSpan
  readonly continue?: boolean
}

/** Trigger hit used to open one source programmatically. */
export interface InputTriggerHit {
  readonly trigger: '/' | '@'
  readonly query: string
  readonly quoted: boolean
  readonly position: 'leading' | 'inline'
  readonly span: TokenSpan
}

/** Structural per-Session trigger provider consumed by the input shell. */
export interface InputTriggerController {
  readonly launcher: ObservableSnapshot<string | null>
  readonly lexicon: ObservableSnapshot<ReadonlyMap<'/' | '@', readonly string[]>>
  /** @param draft - current draft. @param caret - caret offset. @param guard - availability tier. @param draftRev - input revision. */
  track(
    draft: string,
    caret: number,
    guard: { readonly tier: 'plain' | 'claimed' | 'frozen' },
    draftRev: number,
  ): void
  /** @param key - intercepted key. @param composing - whether IME composition is active. @returns routing result. */
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome
  /** @returns whether Space applied a trigger result. */
  onSpace(): boolean
  /** @param source - reference source. @param ref - source-local id. @param signal - submit cancellation. @returns model text. */
  serializeReference(source: string, ref: string, signal: AbortSignal): Promise<string>
  /** @param line - trimmed draft. @param signal - submit cancellation. @param envelope - attachment count. @returns winning result. */
  adjudicate(
    line: string,
    signal: AbortSignal,
    envelope: { readonly images: number },
  ): Promise<PickOutcome>
  /** @param source - source name. @param hit - synthetic trigger hit. */
  toggleSource(source: string, hit: InputTriggerHit): void
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Claim a command token for the scoped input machine.
     * @param request - command claim and span.
     * @mode bail
     */
    'slash/input-begin-command'(request: BeginCommandRequest): true | undefined
    /**
     * Insert a structured reference into the scoped input machine.
     * @param request - reference and span.
     * @mode bail
     */
    'slash/input-insert-reference'(request: InsertReferenceRequest): true | undefined
    /**
     * Consume a trigger token without inserting replacement content.
     * @param request - token guard.
     * @mode bail
     */
    'slash/input-consume-token'(request: ConsumeTokenRequest): true | undefined
    /**
     * Insert plain text into the scoped input machine.
     * @param request - plain text and span.
     * @mode bail
     */
    'slash/input-insert-text'(request: InsertTextRequest): true | undefined
  }
}

/** Browser-runtime identity of one unsent image draft. */
export type DraftAttachmentId = Branded<'DraftAttachmentId'>

/**
 * The scoped-event application verbs: the hub's bail listeners call these,
 * and the boolean answer IS the event's bail value (true ⟺ the machine
 * accepted after phase and span/bare-token guards).
 */
export interface InputTarget {
  /** Replace the trigger span with claim.token and enter claimed (span-CAS'd). */
  beginCommand(claim: CommandClaim, span: TokenSpan): boolean
  /** Replace the trigger span with one reference occurrence (span-CAS'd). */
  insertReference(ref: ReferenceInsert, span: TokenSpan): boolean
}

/** Per-session input facade owned by the conversation wiring layer. */
export interface SessionInput extends InputTarget {
  /** Single write path for draft text (all mutation rides machine events). */
  setDraft(text: string): void
  /** Append ordered browser-owned image ids; busy admission phases refuse. */
  addImages(ids: readonly DraftAttachmentId[]): boolean
  /** Remove one browser-owned image id; busy admission phases refuse. */
  removeImage(id: DraftAttachmentId): void
  /** Drop ids whose browser-owned objects no longer exist. */
  pruneImages(ids: readonly DraftAttachmentId[]): void
  /**
   * THE complexity sink: enter adjudication, submit transaction, and the default sink live inside.
   * @param mode - delivery intent retained through asynchronous adjudication and serialization.
   */
  submit(mode?: InputSubmitMode): void
  /**
   * Surface a notice outside the machine's own effect stream: detached
   * command results and business notifications render through here.
   * Session-routed — resolving the facade via SessionInputResolver.for(actx) lands
   * the notice on that session's composer, so a result arriving after a
   * session switch still reaches its own session.
   * @param level - severity tier.
   * @param text - notice body.
   */
  notify(level: 'info' | 'error', text: string): void
  /** Input state store (InputZone currency + decorations read here). */
  readonly state: SnapshotStore<InputState>
}

/** Session-addressed access to the per-session input facade. */
export interface SessionInputResolver {
  /** Resolve the facade for one session-scope ctx. */
  for(actx: Context): SessionInput
}

/**
 * The public input action face provided to every session-scope slot
 * component: two stable-identity void callbacks, mirroring the
 * useStore+actions convention. Command-style handles (track/arbitrate/space/
 * undo/paste/…) stay InputBar-private and never ride this face.
 */
export interface InputActions {
  /** Single public draft write path (full next draft; occurrence math via diff scan). */
  setDraft(text: string): void
  /** Append ordered browser-owned image ids; busy admission phases refuse. */
  addImages(ids: readonly DraftAttachmentId[]): boolean
  /** Remove one browser-owned image id; busy admission phases refuse. */
  removeImage(id: DraftAttachmentId): void
  /** Drop ids whose browser-owned objects no longer exist. */
  pruneImages(ids: readonly DraftAttachmentId[]): void
  /** Enter submission (adjudication / claim transaction / default sink inside). */
  submit(): void
}

/** One surfaced notice (command results, adjudication failures). seq keys re-render of repeats. */
export interface InputNotice {
  readonly level: 'info' | 'error'
  readonly text: string
  readonly seq: number
}

/**
 * The InputBar-exclusive keyboard/DOM command face: synchronous
 * returns and event-handler semantics that must not enter the public provide
 * channel. Handed to the composer-bar entry through its own inject —
 * package-internal, never across a plugin boundary. The session shell
 * satisfies it structurally.
 */
export interface ComposerKeyboard {
  /** Live machine state for event-handler reads (render reads go through useInput). */
  readonly snapshot: InputState
  /** Draft write with the DOM-observed edit shape (narrows occurrence math). */
  setDraft(text: string, editRange?: EditRange): void
  /** Submit with an explicit delivery mode resolved by the keyboard policy. */
  submit(mode: InputSubmitMode): void
  /**
   * Steer every still-pending queued message into the running turn (the
   * empty-draft accelerated-Enter gesture; the queue dock's per-row steer
   * button is the same operation applied to the whole queue).
   */
  steerQueue(): void
  undo(): void
  redo(): void
  /** Paste over the selection (sync components ride the same transaction). */
  pasteBegin(text: string, selection: EditSelection, components?: readonly PasteComponent[], generation?: number): void
  /** Caret/selection gestures the machine cannot observe end the paste attempt. */
  invalidatePaste(): void
  /** Feed a draft/caret change through trigger detection (guard derived from phase). */
  track(draft: string, caret: number): void
  /** Keyboard arbitration while the menu is open ('pass' when no pipeline). */
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome
  /** Space adjudication; true = the input applied a claim — caller preventDefaults. */
  space(): boolean
  /** Dismiss the popupSelect shell (any interaction outside the box). */
  dismissPopup(): void
}

/** One independently addressable row projected from the transient queue snapshot. */
export type QueuedMessage = QueueRow

/** Guard union of the scoped consume-token event, checked by the machine. */
export type ConsumeTokenGuard = ConsumeTokenRequest['guard']

/** Half-open [start, end) range/selection in draft character coordinates. */
export interface EditSelection {
  readonly start: number
  readonly end: number
}

/**
 * One edit applied to the previous draft: [start, end) in the PREVIOUS
 * draft's coordinates was replaced by insertedLength characters. Supplied by
 * the wiring layer when the DOM event exposes the edit shape; absent, the
 * machine recovers it with a prefix/suffix common-scan diff.
 */
export interface EditRange extends EditSelection {
  readonly insertedLength: number
}

/**
 * One reference occurrence backed by its complete inline display text in the
 * draft. Identity is occurrenceId — same-named
 * references stay independently addressable. label/appearance/clipboardText are the
 * owner's insert-time projections, cached so the chip survives owner loss
 * (invalid flips instead of dropping the occurrence).
 */
export interface Occurrence {
  /** Machine-minted stable identity (monotonic per machine). */
  readonly occurrenceId: number
  /** Owning source name (serializer routing key). */
  readonly source: string
  /** Owner-scoped reference id. */
  readonly ref: string
  /** Display-text offset in the draft. */
  readonly offset: number
  /** Display-text length; the occurrence occupies exactly [offset, offset+length). */
  readonly length: number
  /** Inline display label (insert-time cache). */
  readonly label: string
  /** Optional domain glyph (insert-time cache). */
  readonly appearance?: ReferenceInsert['appearance']
  /** Clipboard / persistence projection, e.g. `/name` (insert-time cache, never the model form). */
  readonly clipboardText: string
  /** Owner-resolution failure flag: chip renders invalid; serialization must fail. */
  readonly invalid?: boolean
}

/** One sync-matched paste component; start/end are relative to the pasted text. */
export interface PasteComponent extends EditSelection {
  readonly reference: ReferenceInsert
}

/**
 * Live paste-match attempt published while async matching may still upgrade
 * pasted tokens (the clipboard round-trip). Any non-paste transaction,
 * submit start, invalidate-paste, or release ends it; a paste-upgrade keeps
 * it current (later tokens re-CAS against the advanced draftRev).
 */
export interface PasteAttemptState {
  /** Machine-minted attempt identity (paste-upgrade must match it). */
  readonly attemptId: number
  /** Pasted range in the draft as of the paste transaction. */
  readonly insertedRange: EditSelection
  /** Caller-supplied projection generation echoed back (the controller drops cross-generation results). */
  readonly generation: number
}

/**
 * InputMachine construction knobs. The machine never reads an ambient clock:
 * `now` is the only time source, injected by the shell (tests inject a
 * fake). The default clock is constant, i.e. consecutive single-char typing
 * always coalesces until a non-typing transaction intervenes.
 */
export interface InputMachineOptions {
  /** Single-char typing undo-merge window in ms (default 1000). */
  readonly mergeWindowMs?: number
  /** Monotonic clock for typing-merge decisions (default: constant 0). */
  readonly now?: () => number
}

/** Published input state (the currency; per-session). */
export interface InputState {
  readonly draft: string
  /** Ordered runtime-only image ids; bytes and URLs stay in ConversationController. */
  readonly imageIds: readonly DraftAttachmentId[]
  /** Monotonic draft revision (span CAS compares against this). */
  readonly draftRev: number
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  /** Present exactly while claimed/submitting (claim snapshot during flight; submit closure withheld). */
  readonly claim?: { readonly token: string; readonly hint?: string; readonly images?: boolean }
  /** Reference occurrence table, sorted by offset. */
  readonly occurrences: readonly Occurrence[]
  /** Live paste-match attempt (absent when no paste is matchable). */
  readonly paste?: PasteAttemptState
  /** Read-only transient inbox projection from Session control, including pending steering. */
  readonly queue: readonly QueuedMessage[]
}

/**
 * One in-flight submission attempt: the ONLY id concept in the submit plane.
 * Created on enter; carried by adjudicated/submit-settled events; stale
 * attempts are dropped (anti-backwash). release/session teardown aborts the
 * current attempt, keeping the promise bounded.
 */
export interface SubmitAttempt {
  readonly seq: number
  readonly signal: AbortSignal
  /** Draft at enter time; settlement clears it only after acceptance. */
  readonly draftSnapshot: string
  /** Default-message delivery intent retained while slash adjudication is pending. */
  readonly mode: InputSubmitMode
}

/**
 * InputMachine input events (the machine's single write path). Every draft
 * mutation is one transaction: draft edit, occurrence reconciliation, and
 * undo-log push are atomic inside dispatch(). Events carrying `at` stamp the
 * injected clock reading; only single-char typing coalescing reads it.
 */
export type InputEvent =
  /** Full next draft from the textarea; editRange narrows the occurrence math (absent → diff scan). */
  | { readonly type: 'draft-changed'; readonly draft: string; readonly editRange?: EditRange }
  | { readonly type: 'begin-command'; readonly claim: CommandClaim; readonly span: TokenSpan }
  /** Place one inline reference at the span and mint the occurrence (scoped insert-reference event payload). */
  | { readonly type: 'insert-ref'; readonly reference: ReferenceInsert; readonly span: TokenSpan }
  /** Delete a settled command token; success is observable as a draftRev advance. */
  | { readonly type: 'consume-token'; readonly guard: ConsumeTokenGuard }
  /** Owner-resolution result: exactly the listed occurrences are invalid (style bit; not a transaction). */
  | { readonly type: 'set-invalid'; readonly invalidIds: readonly number[] }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  /**
   * Paste text replacing the selection, one transaction. Hot-snapshot sync
   * matches ride in as components (chips minted inside the SAME transaction:
   * one undo returns to pre-paste); a PasteMatchAttempt opens for the async
   * remainder. Component ranges must be disjoint and inside the pasted text.
   */
  | { readonly type: 'paste-begin'; readonly text: string; readonly selection: EditSelection; readonly components?: readonly PasteComponent[]; readonly generation?: number }
  /** Async match landed: upgrade one pasted token to a chip as an INDEPENDENT transaction (undo #1 → text, undo #2 → pre-paste). */
  | { readonly type: 'paste-upgrade'; readonly attemptId: number; readonly span: TokenSpan; readonly reference: ReferenceInsert }
  /** Shell-observed attempt killers the machine cannot see itself (caret/selection ops, Slash interaction updates). */
  | { readonly type: 'invalidate-paste' }
  | { readonly type: 'enter'; readonly mode: InputSubmitMode }
  | { readonly type: 'adjudicated'; readonly attempt: SubmitAttempt; readonly outcome: PickOutcome }
  | { readonly type: 'adjudication-failed'; readonly attempt: SubmitAttempt; readonly message: string }
  | { readonly type: 'submit-settled'; readonly attempt: SubmitAttempt; readonly ok: boolean; readonly outcome?: SubmitOutcome; readonly message?: string }
  /** Commit an image-only send whose empty draft did not need an attempt. */
  | { readonly type: 'send-committed' }
  | { readonly type: 'release' }

/**
 * InputMachine output effects (executed by the SessionInput shell; the
 * machine stays pure). Draft/occurrence mutations carry no effect — the
 * shell publishes the state store after every dispatch.
 */
export type InputEffect =
  | { readonly type: 'adjudicate'; readonly attempt: SubmitAttempt; readonly draft: string }
  | { readonly type: 'begin-submit'; readonly attempt: SubmitAttempt; readonly claim: CommandClaim; readonly args: string }
  | { readonly type: 'default-sink'; readonly attempt: SubmitAttempt; readonly draft: string; readonly mode: InputSubmitMode }
  | { readonly type: 'notice'; readonly level: 'info' | 'error'; readonly text: string }
