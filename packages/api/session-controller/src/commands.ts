/** Session commands whose activation policy is explicit at each Remote method. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import { AttachmentError, admitPromptContent } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  ReasoningEffortId, createUserMessage, freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
  ApiSessionNotFound,
  ApiSessionPresetConflict,
  ApiSessionSubagentOwnership,
  apiSessionSubagentOwnershipError,
  hasApiSessionSubagentOwner,
  inspectApiSession,
} from './agent.ts'
import type {
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionCreateRequest,
  SessionCreateValue,
  SessionEditRequest,
  SessionEditValue,
  SessionForkRequest,
  SessionForkValue,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
} from './types.ts'

interface SessionReadState {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

/** One admitted edit and the exact replacement event it is waiting to commit. */
interface EditAdmission {
  readonly committed: Promise<SessionEvent<'user/message'>>
}

/** Expected loss of the exact edit admission after it was queued. */
class EditAdmissionStale extends Error {}

/** Preserve the Agent maintenance refusal as a retryable Session-domain failure. */
function editMaintenanceBusy(agent: Agent, error: unknown): RemoteError<'session/agent-busy'> {
  return new RemoteError(
    'session/agent-busy',
    `session "${agent.id}" is busy with another maintenance operation`,
    { reason: String(error) },
    { cause: error },
  )
}

/** Validated replacement ranges and original content for one edit request. */
interface EditTarget {
  readonly event: SessionEvent<'user/message'>
  readonly turnStartSeq: SessionSeq
  readonly rawEndSeq: SessionSeq
  readonly surfaceStart: SessionSeq
  readonly surfaceEnd: SessionSeq
  readonly shadowedSurfaceSeqs: SessionSeq[]
  readonly preservedContexts: readonly SessionEvent<'user/message'>[]
}

/** Implements Session business commands delegated by the Session Controller Remote service. */
export class SessionCommandController {
  /**
   * @param ctx - Host context carrying Agent, model, attachment, title, and Workspace services.
   * @param agents - sole owner of create, resume, and Session-local model selection.
   * @param defaultCwd - project directory used when create names neither a Workspace nor a cwd.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
    private readonly defaultCwd: string,
  ) {}

  /**
   * Create or idempotently adopt one ordinary Session.
   * @param request - requested identity, location, and Agent preset.
   * @returns the Session identity and resolved preset when configured.
   */
  async create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    if (request.workspaceId !== undefined && request.cwd !== undefined) {
      throw new RemoteError('gateway/bad-request', 'session.create accepts workspaceId or cwd, not both', {})
    }
    const sessionId = request.sessionId ?? brandString<SessionId>(`session-${randomUUID()}`)
    let workspace: Workspace | undefined
    if (request.workspaceId !== undefined) {
      workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
      if (workspace === undefined) {
        throw new RemoteError('workspace/not-found', `workspace "${request.workspaceId}" not found`, {
          workspaceId: request.workspaceId,
        })
      }
    }
    const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
    let adopted: Agent
    try {
      adopted = await this.agents.ensureSession(
        sessionId,
        cwd,
        request.sessionId !== undefined,
        request.agentPreset,
      )
    } catch (error) {
      this.rejectCreation(sessionId, error)
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId, workspaceId: workspace.id },
        )
      }
    }
    const agentPreset = this.agents.presetForSession(adopted.session)
    return { sessionId, ...(agentPreset === undefined ? {} : { agentPreset }) }
  }

  /**
   * Validate and install one Session-local model selection.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session.
   */
  async selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    const agent = await this.resolveAgent(request.sessionId)
    return this.agents.serializeImageAdmission(agent, async () => {
      try {
        const resolved = await this.ctx.llm.resolveCallConfig({
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }),
        })
        const selected: AgentModelSelection = {
          provider: resolved.provider,
          model: resolved.model,
          ...(resolved.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: resolved.reasoningEffort }),
        }
        this.agents.selectForNextRequest(agent, selected)
        try {
          await this.ctx.agentDefaultModel.saveSelection(selected)
        } catch (error) {
          this.ctx.logger.warn(
            `session-controller: model selection changed for the Session but the default was not saved: ${String(error)}`,
          )
        }
        return { selected: { ...selected } }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'session/model-unavailable',
          error instanceof Error ? error.message : String(error),
          { provider: request.provider, model: request.model },
        )
      }
    })
  }

  /**
   * Normalize and append a user-owned Session title.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  async rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    const agent = await this.resolveAgent(request.sessionId)
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined) {
      throw new RemoteError('gateway/internal', 'renaming is unavailable: this deployment mounts no session-title service', {})
    }
    try {
      const accepted = titles.rename(agent.session, request.title)
      return { title: accepted.title, seq: accepted.eventSeq }
    } catch (error) {
      if (error instanceof SessionTitleInvalidError) {
        throw new RemoteError('session/title-invalid', error.message, { sessionId: request.sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `failed to rename session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
  }

  /**
   * Create a new ordinary Session from one completed-turn prefix.
   * @param request - source Session and optional event anchor.
   * @returns the new Session identity.
   */
  async fork(request: SessionForkRequest): Promise<SessionForkValue> {
    let atSeq: ReturnType<typeof SessionSeq> | undefined
    try {
      atSeq = request.atSeq === undefined ? undefined : SessionSeq(request.atSeq)
    } catch {
      throw new RemoteError('gateway/bad-request', 'atSeq must be a non-negative safe integer', {})
    }
    let observed: SessionObservation
    try {
      observed = await this.ctx.sessionQuery.observeSession(request.sessionId)
    } catch (error) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${request.sessionId}" not found`, {
          sessionId: request.sessionId,
        })
      }
      throw new RemoteError(
        'gateway/internal',
        `fork source unavailable for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    using source = observed
    const lastSeq = source.events.at(-1)?.seq ?? -1
    const anchoredBoundary = atSeq === undefined
      ? undefined
      : source.events.find(event => event.type === 'turn/end' && event.seq >= atSeq)
    const boundary = anchoredBoundary
      ?? (atSeq === undefined || atSeq > lastSeq
        ? source.events.findLast(event => event.type === 'turn/end')
        : undefined)
    if (boundary === undefined) {
      throw new RemoteError(
        'session/fork-unavailable',
        atSeq !== undefined && atSeq <= lastSeq
          ? `session "${request.sessionId}" has not completed the turn containing event ${String(atSeq)}`
          : `session "${request.sessionId}" has no completed turn to fork from`,
        { sessionId: request.sessionId },
      )
    }
    let cut = SessionLogOffset(boundary.seq + 1)
    while (cut < source.events.length && source.events[cut]?.type !== 'turn/start') {
      cut = SessionLogOffset(cut + 1)
    }
    let workspace: Workspace | undefined
    try {
      workspace = await this.forkWorkspace(source.header)
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to resolve fork workspace for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    const childId = brandString<SessionId>(`session-${randomUUID()}`)
    const composition = await this.agents.composeAgent(this.agents.presetForObservation(source))
    try {
      const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
      await this.ctx.agents.create({
        sessionId: childId,
        seed: source.events.slice(0, cut),
        inheritedEventCount: cut,
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          parentSession: source.header.id,
          isSeeded: true,
          ...(composition.agentPreset === undefined
            ? {}
            : { agentPreset: composition.agentPreset }),
        },
        agentOptions: { provider, model },
        setup: composition.setup,
      })
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to fork session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(childId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId: childId, workspaceId: workspace.id },
        )
      }
    }
    return { sessionId: childId }
  }

  /**
   * Admit one browser prompt after explicit Agent resume and image validation.
   * @param request - Session identity, prompt content, source metadata, and delivery mode.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  async prompt(request: SessionPromptRequest): Promise<SessionPromptValue> {
    const clientTimeZone = request.clientTimeZone === undefined
      ? undefined
      : canonicalClientTimeZone(request.clientTimeZone)
    if (request.clientTimeZone !== undefined && clientTimeZone === undefined) {
      throw new RemoteError(
        'session/invalid-time-zone',
        'clientTimeZone must be UTC or a valid IANA Area/Location name',
        { value: request.clientTimeZone },
      )
    }
    const agent = await this.resolveAgent(request.sessionId)
    const selection = this.agents.selectionFor(agent).current
    if (!routeServed(this.ctx, selection.provider)) {
      throw new RemoteError(
        'session/model-unavailable',
        `no adapter serves provider "${selection.provider}"; select a model for this session`,
        { provider: selection.provider, model: selection.model },
      )
    }
    const source: MessageSource = {
      kind: 'user',
      rpcId: request.requestId,
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    }
    const hasImage = request.content.some(part => part.type === 'image')
    const admit = async (): Promise<SessionPromptValue> => {
      try {
        if (hasImage) {
          const current = this.agents.selectionFor(agent).current
          const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model)
          if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
            throw new RemoteError(
              'session/attachment-invalid',
              `Model "${current.model}" does not support image input.`,
              { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
            )
          }
        }
        const content = await admitPromptContent(this.ctx.attachments, request.content)
        const message: UserMessage = createUserMessage({ content, source })
        if (request.mode === 'steer') agent.steer(message)
        else agent.followup(message)
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        if (error instanceof AttachmentError) {
          throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
        }
        throw new RemoteError('session/agent-busy', 'prompt rejected', { reason: String(error) })
      }
      return { accepted: true }
    }
    return hasImage ? this.agents.serializeImageAdmission(agent, admit) : admit()
  }

  /**
   * Replace the latest current turn-opening human message and prioritize its rerun
   * ahead of already queued turns.
   * @param request - target message, optimistic revision, and replacement text.
   * @param signal - caller cancellation observed before inbox admission.
   * @returns acknowledgement after the replacement message enters the log.
   */
  async edit(request: SessionEditRequest, signal: AbortSignal): Promise<SessionEditValue> {
    validateEditRequest(request)
    signal.throwIfAborted()
    const agent = await this.resolveAgent(request.sessionId)
    const initialTarget = resolveEditTarget(agent.session, request)
    replaceMessageText(initialTarget.event.data.content, request.text)
    const hasImage = initialTarget.event.data.content.some(block => block.type === 'image')
    const clientTimeZone = request.clientTimeZone === undefined
      ? undefined
      : canonicalClientTimeZone(request.clientTimeZone)
    if (request.clientTimeZone !== undefined && clientTimeZone === undefined) {
      throw new RemoteError(
        'session/invalid-time-zone',
        'clientTimeZone must be UTC or a valid IANA Area/Location name',
        { value: request.clientTimeZone },
      )
    }
    const admit = async (): Promise<SessionEditValue> => {
      const selection = this.agents.selectionFor(agent).current
      if (!routeServed(this.ctx, selection.provider)) {
        throw new RemoteError(
          'session/model-unavailable',
          `no adapter serves provider "${selection.provider}"; select a model for this session`,
          { provider: selection.provider, model: selection.model },
        )
      }
      if (hasImage) {
        const model = await this.ctx.llm.resolveModelInfo(selection.provider, selection.model)
        if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
          throw new RemoteError(
            'session/attachment-invalid',
            `Model "${selection.model}" does not support image input.`,
            { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
          )
        }
      }
      let committed: SessionEvent<'user/message'>
      try {
        let admission: EditAdmission
        if (agent.status === 'running') {
          admission = await this.reserveMaintenanceAfterCancel(agent, signal, () => {
            signal.throwIfAborted()
            return Promise.resolve(this.admitEdit(agent, request, clientTimeZone))
          })
        } else {
          let maintenance: Promise<EditAdmission>
          try {
            maintenance = agent.runMaintenance((maintenanceSignal) => {
              signal.throwIfAborted()
              maintenanceSignal.throwIfAborted()
              return Promise.resolve(this.admitEdit(agent, request, clientTimeZone))
            })
          } catch (error: unknown) {
            throw editMaintenanceBusy(agent, error)
          }
          admission = await maintenance
        }
        committed = await admission.committed
      } catch (error: unknown) {
        if (remoteErrorOf(error) !== undefined || signal.aborted) throw error
        if (error instanceof EditAdmissionStale) {
          throw new RemoteError(
            'session/edit-stale',
            `session "${request.sessionId}" changed before the edit could be admitted`,
            { sessionId: request.sessionId, messageSeq: request.messageSeq },
            { cause: error },
          )
        }
        throw new RemoteError(
          'gateway/internal',
          `session "${request.sessionId}" edit admission failed: ${String(error)}`,
          {},
          { cause: error },
        )
      }
      return { accepted: true, messageSeq: committed.seq }
    }
    return hasImage ? this.agents.serializeImageAdmission(agent, admit) : admit()
  }

  /**
   * Read one durable image after proving the Session log references it.
   * @param request - Session and attachment identities used for authorization.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  async attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    let source: SessionReadState
    try {
      source = await this.readSessionState(request.sessionId)
    } catch (error) {
      if (error instanceof ApiSessionNotFound) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `attachment authorization unavailable for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    const ref = referencedImage(source.events, String(request.attachmentId))
    if (ref === undefined) {
      throw new RemoteError(
        'session/attachment-invalid',
        'Image is not referenced by this session.',
        { reason: 'ATTACHMENT_NOT_REFERENCED' },
      )
    }
    try {
      const stored = await this.ctx.attachments.readImage(ref)
      return {
        attachment: stored.ref,
        data: Buffer.from(stored.data).toString('base64'),
      }
    } catch (error) {
      if (error instanceof AttachmentError) {
        throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
      }
      throw new RemoteError('gateway/internal', 'Unable to read image attachment.', {})
    }
  }

  /**
   * Mutate one still-pending queue occurrence without resuming a cold Agent.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  updateQueue(request: SessionUpdateQueueRequest): SessionUpdateQueueValue {
    if (request.action.kind === 'edit'
      && request.action.content.some(block => block.type !== 'text')) {
      throw new RemoteError(
        'session/attachment-invalid',
        'queue edits accept text content only',
        { reason: 'QUEUE_EDIT_NON_TEXT' },
      )
    }
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent !== undefined && hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw apiSessionSubagentOwnershipError(request.sessionId)
    }
    if (agent === undefined) {
      throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
    }
    const nextTurn = agent.inbox.nextTurn.find(message => message.id === request.itemId)
    const nextStep = agent.inbox.nextStep.find(message => message.id === request.itemId)
    const located = nextTurn === undefined
      ? nextStep === undefined ? undefined : { target: 'next-step' as const, message: nextStep }
      : { target: 'next-turn' as const, message: nextTurn }
    if (located === undefined) {
      throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
    }
    const { target, message } = located
    if (request.action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
      throw new RemoteError('session/steer-unavailable', 'current turn no longer accepts steering', { itemId: request.itemId })
    }
    if (request.action.kind === 'edit') {
      agent.inbox.replace(request.itemId, freezeMessage<UserMessage>({
        ...message,
        content: [...request.action.content],
      }))
    } else {
      agent.inbox.remove(request.itemId)
      if (request.action.kind === 'steer') agent.steer(message)
    }
    return { accepted: true }
  }

  /**
   * Cancel one live ordinary Agent while retaining pending inbox work.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  cancel(request: SessionCancelRequest): SessionCancelValue {
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      throw new RemoteError(
        'session/not-found',
        `session "${request.sessionId}" not found (not attached)`,
        { sessionId: request.sessionId },
      )
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw apiSessionSubagentOwnershipError(request.sessionId)
    }
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { accepted: true }
  }

  private async resolveAgent(sessionId: SessionId): Promise<Agent> {
    const found = await this.agents.resolveAgent(sessionId)
    if ('error' in found) throw found.error
    return found.agent
  }

  private rejectCreation(sessionId: SessionId, error: unknown): never {
    if (remoteErrorOf(error) !== undefined) throw error
    if (error instanceof ApiSessionPresetConflict) {
      throw new RemoteError('agent-preset/conflict', error.message, {
        sessionId: error.sessionId,
        requestedPreset: error.requestedPreset,
        ...(error.existingPreset === undefined ? {} : { existingPreset: error.existingPreset }),
      })
    }
    if (error instanceof ApiSessionCwdConflict) {
      throw new RemoteError('session/conflict', error.message, {
        sessionId: error.sessionId,
        requestedCwd: error.requestedCwd,
        ...(error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd }),
      })
    }
    if (error instanceof ApiSessionSubagentOwnership) {
      throw apiSessionSubagentOwnershipError(error.sessionId)
    }
    throw new RemoteError('gateway/internal', `failed to create session "${sessionId}": ${String(error)}`, {})
  }

  private async readSessionState(sessionId: SessionId): Promise<SessionReadState> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      return { id: attached.id, header: attached.header, events: attached.snapshotEvents() }
    }
    const inspected = await inspectApiSession(this.ctx, sessionId)
    return { id: inspected.meta.id, header: inspected.meta, events: inspected.events }
  }

  /** Cancel a running turn and synchronously reserve maintenance at its idle transition. */
  private reserveMaintenanceAfterCancel<Value>(
    agent: Agent,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<Value>,
  ): Promise<Value> {
    signal.throwIfAborted()
    return new Promise<Value>((resolve, reject) => {
      let settled = false
      const finish = (result: Promise<Value>): void => {
        /* v8 ignore next -- every finishing path removes the other listeners before yielding. */
        if (settled) return
        settled = true
        dispose()
        signal.removeEventListener('abort', abort)
        result.then(resolve, reject)
      }
      const abort = (): void => {
        const reason = signal.reason instanceof Error
          ? signal.reason
          : new Error('edit request aborted', { cause: signal.reason })
        finish(Promise.reject(reason))
      }
      const dispose = this.ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject !== agent || status !== 'idle') return
        try {
          finish(agent.runMaintenance(operation))
        } catch (error: unknown) {
          finish(Promise.reject(editMaintenanceBusy(agent, error)))
        }
      }, { global: true })
      signal.addEventListener('abort', abort, { once: true })
      try {
        agent.cancel({ kind: 'user' }, { keepInbox: true })
      } catch (error: unknown) {
        finish(Promise.reject(error instanceof Error ? error : new Error('edit cancellation failed', { cause: error })))
      }
    })
  }

  /** Validate and enqueue one edit while maintenance owns the idle Agent. */
  private admitEdit(
    agent: Agent,
    request: SessionEditRequest,
    clientTimeZone: string | undefined,
  ): EditAdmission {
    const target = resolveEditTarget(agent.session, request)
    const source: MessageSource = {
      kind: 'user',
      rpcId: request.requestId,
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    }
    const message = createUserMessage({
      content: replaceMessageText(target.event.data.content, request.text),
      source,
    })
    const followingMessages = target.preservedContexts.map(context => createUserMessage({
      content: [...context.data.content],
      source: context.data.source,
    }))
    const waiter = waitForEditedMessage(this.ctx, agent, message.id)
    try {
      agent.send(message, 'next-turn', true, {
        position: 'front',
        followingMessages,
        surfaceIntent: {
          surfaceOp: {
            op: 'replace',
            start: target.surfaceStart,
            end: target.surfaceEnd,
          },
          sourceEventSeqs: target.shadowedSurfaceSeqs,
          conversationOp: {
            op: 'replace',
            start: target.turnStartSeq,
            end: target.rawEndSeq,
          },
        },
      })
    } catch (error: unknown) {
      waiter.dispose()
      throw error
    }
    return { committed: waiter.committed }
  }

  private async forkWorkspace(source: SessionHeader): Promise<Workspace | undefined> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
    if (direct !== undefined || source.origin !== 'subagent') return direct
    const lineage = await this.ctx.sessionQuery.traceSession(source.id)
    for (const ancestor of lineage.ancestors) {
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id))
      if (workspace !== undefined) return workspace
    }
    return undefined
  }
}

/** Validate scalar fields before resolving or interrupting an Agent. */
function validateEditRequest(request: SessionEditRequest): void {
  if (!Number.isSafeInteger(request.messageSeq) || request.messageSeq < 0) {
    throw new RemoteError('gateway/bad-request', 'messageSeq must be a non-negative safe integer', {})
  }
  if (!Number.isSafeInteger(request.expectedLastUserSeq) || request.expectedLastUserSeq < 0) {
    throw new RemoteError('gateway/bad-request', 'expectedLastUserSeq must be a non-negative safe integer', {})
  }
}

/** Resolve the exact current turn and model-surface suffix replaced by an edit. */
function resolveEditTarget(session: Session, request: SessionEditRequest): EditTarget {
  const events = session.snapshotEvents()
  const latestUser = events.findLast(event =>
    event.type === 'user/message' && event.data.source.kind === 'user')
  if (latestUser?.seq !== request.expectedLastUserSeq) {
    throw new RemoteError(
      'session/edit-stale',
      `session "${request.sessionId}" changed after message ${String(request.messageSeq)} entered edit mode`,
      { sessionId: request.sessionId, messageSeq: request.messageSeq },
    )
  }
  const target = events[request.messageSeq]
  if (target?.type !== 'user/message'
    || target.data.source.kind !== 'user'
    || !target.data.content.some(block => block.type === 'text')) {
    throw editUnavailable(request, 'the selected event is not an editable human message')
  }
  if (target.seq !== latestUser.seq) {
    throw editUnavailable(request, 'only the latest human message can be edited')
  }
  const currentSurface = session.surface.nodes
  if (!currentSurface.includes(target.seq)) {
    throw editUnavailable(request, 'the selected message is not in the current model context')
  }
  const turnStart = events.slice(0, target.seq + 1).findLast(event => event.type === 'turn/start')
  if (turnStart?.type !== 'turn/start') {
    throw editUnavailable(request, 'the selected message has no owning turn')
  }
  const firstStepStart = events.find(event =>
    event.seq > turnStart.seq
    && event.type === 'step/start'
    && event.data.turn === turnStart.data.turn)
  if (firstStepStart?.type !== 'step/start' || firstStepStart.data.step !== 1) {
    throw editUnavailable(request, 'the selected message has no first step')
  }
  const stepEndIndex = events.findIndex(event =>
    event.seq > firstStepStart.seq
    && event.type === 'step/end'
    && event.data.turn === turnStart.data.turn
    && event.data.step === firstStepStart.data.step)
  const firstStepEnd = stepEndIndex === -1 ? events.length : stepEndIndex
  const openingRangeStart = target.seq < firstStepStart.seq ? turnStart.seq + 1 : firstStepStart.seq + 1
  const openingRangeEnd = target.seq < firstStepStart.seq ? firstStepStart.seq : firstStepEnd
  const openingHuman = events.slice(openingRangeStart, openingRangeEnd).findLast(event =>
    event.type === 'user/message' && event.data.source.kind === 'user')
  if (openingHuman?.seq !== target.seq) {
    throw editUnavailable(request, 'the selected message is steering rather than the turn-opening prompt')
  }
  const firstSurfaceIndex = currentSurface.findIndex(seq => seq > turnStart.seq && seq <= target.seq)
  const surfaceEnd = currentSurface.at(-1)
  /* v8 ignore next -- target membership above guarantees one same-turn surface node and a non-empty surface. */
  if (firstSurfaceIndex < 0 || surfaceEnd === undefined) {
    throw editUnavailable(request, 'the selected turn has no current model context')
  }
  const shadowedSurfaceSeqs = currentSurface.slice(firstSurfaceIndex)
  return {
    event: target,
    turnStartSeq: turnStart.seq,
    // The indexed target came from this snapshot, so the final event exists.
    rawEndSeq: (events.at(-1) as SessionEvent).seq,
    surfaceStart: shadowedSurfaceSeqs[0] as SessionSeq,
    surfaceEnd,
    shadowedSurfaceSeqs: [...shadowedSurfaceSeqs],
    preservedContexts: events.slice(target.seq + 1, firstStepEnd).filter(isSessionReferenceContext),
  }
}

/** Whether one user-role context is the durable recall paired with a prompt. */
function isSessionReferenceContext(event: SessionEvent): event is SessionEvent<'user/message'> {
  if (event.type !== 'user/message') return false
  const source = event.data.source as { readonly kind?: unknown; readonly form?: unknown }
  return source.kind === 'session-reference' && source.form === 'recall'
}

/** Replace all text blocks with one edited block while retaining non-text content in place. */
function replaceMessageText(content: readonly ContentBlock[], text: string): ContentBlock[] {
  const result: ContentBlock[] = []
  let foundText = false
  for (const block of content) {
    if (block.type !== 'text') {
      result.push(block)
      continue
    }
    if (foundText) continue
    foundText = true
    if (text !== '') result.push({ type: 'text', text })
  }
  /* v8 ignore next -- resolveEditTarget requires a text block before calling this helper. */
  if (!foundText) throw new Error('editable message contains no text block')
  if (result.length === 0) {
    throw new RemoteError('gateway/bad-request', 'edited message cannot be empty', {})
  }
  return result
}

/** Build the stable rejection for a message that cannot be edited. */
function editUnavailable(request: SessionEditRequest, reason: string): RemoteError<'session/edit-unavailable'> {
  return new RemoteError(
    'session/edit-unavailable',
    `session "${request.sessionId}" message ${String(request.messageSeq)} is not editable: ${reason}`,
    { sessionId: request.sessionId, messageSeq: request.messageSeq },
  )
}

/** Wait until the exact edit message commits, or its owning turn closes without it. */
function waitForEditedMessage(
  ctx: Context,
  agent: Agent,
  messageId: MessageId,
): { readonly committed: Promise<SessionEvent<'user/message'>>; readonly dispose: () => void } {
  let claimedTurn: number | undefined
  const disposers: Array<() => void> = []
  const dispose = (): void => {
    for (const disposeListener of disposers.splice(0)) disposeListener()
  }
  const promise = new Promise<SessionEvent<'user/message'>>((resolve, reject) => {
    const finish = (outcome: { event: SessionEvent<'user/message'> } | { error: Error }): void => {
      dispose()
      if ('event' in outcome) resolve(outcome.event)
      else reject(outcome.error)
    }
    disposers.push(ctx.on('agent/inbox/claimed', ({ agent: subject, message, turn }) => {
      if (subject === agent && message.id === messageId) claimedTurn = turn
    }, { global: true }))
    disposers.push(ctx.on('agent/inbox/discarded', ({ agent: subject, message }) => {
      if (subject !== agent || message.id !== messageId) return
      finish({ error: new EditAdmissionStale('edit message was discarded before it committed') })
    }, { global: true }))
    disposers.push(ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'user/message' && event.data.id === messageId) {
        finish({ event })
        return
      }
      if (claimedTurn !== undefined
        && event.type === 'turn/end'
        && event.data.turn === claimedTurn) {
        finish({ error: new EditAdmissionStale('edit turn ended before the replacement message committed') })
      }
    }, { global: true }))
    disposers.push(ctx.on('agent/disposed', ({ agent: subject }) => {
      if (subject === agent) {
        finish({ error: new EditAdmissionStale('edit agent was disposed before the replacement message committed') })
      }
    }, { global: true }))
  })
  return { committed: promise.finally(dispose), dispose }
}

function imageBlockIn(
  content: unknown,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { readonly type?: unknown; readonly attachment?: unknown; readonly content?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ImageAttachmentRef
      if (match(ref)) return ref
    }
    if (block.type === 'tool-result') {
      const nested = imageBlockIn(block.content, match)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function imageInEvent(
  event: SessionEvent,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  const data = event.data as {
    readonly content?: unknown
    readonly message?: { readonly content?: unknown }
    readonly inserted?: readonly { readonly content?: unknown }[]
    readonly chunk?: { readonly type?: unknown; readonly block?: unknown }
  }
  const direct = imageBlockIn(data.content, match)
  if (direct !== undefined) return direct
  const message = imageBlockIn(data.message?.content, match)
  if (message !== undefined) return message
  for (const inserted of data.inserted ?? []) {
    const found = imageBlockIn(inserted.content, match)
    if (found !== undefined) return found
  }
  return event.type === 'assistant/chunk' && data.chunk?.type === 'block-end'
    ? imageBlockIn([data.chunk.block], match)
    : undefined
}

function referencedImage(
  events: readonly SessionEvent[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  for (const event of events) {
    const found = imageInEvent(event, ref => String(ref.attachmentId) === attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}

function routeServed(ctx: Context, provider: string): boolean {
  return ctx.llm.listProviders().some(entry => entry.id === provider)
}
