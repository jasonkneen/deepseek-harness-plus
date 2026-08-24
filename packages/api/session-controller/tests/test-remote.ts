/** Test-only direct Remote face over the Session Controller's internal controllers. */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import { vi } from 'vitest'
import {
  TypertRemoteFailure,
  type RemoteResult,
} from '@deepseek-ai/dsh-typert-protocol'
import SessionController from '../src/index.ts'
import type {
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionControlFrame,
  SessionCreateRequest,
  SessionCreateValue,
  SessionForkRequest,
  SessionForkValue,
  SessionListRequest,
  SessionListValue,
  SessionModels,
  SessionModelsRequest,
  SessionPage,
  SessionPageRequest,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSearchRequest,
  SessionSearchValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
} from '../src/types.ts'

/** Direct test face matching the generated `ctx.remote.session` unary methods. */
export interface TestSessionRemote {
  list(request: SessionListRequest, signal?: AbortSignal): Promise<RemoteResult<SessionListValue>>
  search(request: SessionSearchRequest, signal?: AbortSignal): Promise<RemoteResult<SessionSearchValue>>
  create(request: SessionCreateRequest): Promise<RemoteResult<SessionCreateValue>>
  models(request: SessionModelsRequest): Promise<RemoteResult<SessionModels>>
  selectModel(request: SessionSelectModelRequest): Promise<RemoteResult<SessionSelectModelValue>>
  rename(request: SessionRenameRequest): Promise<RemoteResult<SessionRenameValue>>
  fork(request: SessionForkRequest): Promise<RemoteResult<SessionForkValue>>
  prompt(request: SessionPromptRequest, signal?: AbortSignal): Promise<RemoteResult<SessionPromptValue>>
  attachment(request: SessionAttachmentRequest): Promise<RemoteResult<SessionAttachmentValue>>
  updateQueue(request: SessionUpdateQueueRequest): Promise<RemoteResult<SessionUpdateQueueValue>>
  cancel(request: SessionCancelRequest): Promise<RemoteResult<SessionCancelValue>>
  page(request: SessionPageRequest, signal?: AbortSignal): Promise<RemoteResult<SessionPage>>
  control(signal?: AbortSignal): AsyncIterable<SessionControlFrame>
}

/** Dependencies and policy supplied by a Session Controller unit harness. */
export interface TestSessionRemoteDefaults {
  readonly defaultModelSelection: () => AgentModelSelection
  readonly cwd: string
  readonly coldBlankProbeMaxBytes?: number
  readonly saveDefaultModelSelection?: (selection: AgentModelSelection) => void | Promise<void>
}

const installed = new WeakMap<Context, SessionController>()

function installControllers(
  ctx: Context,
  defaults: TestSessionRemoteDefaults,
): SessionController {
  const found = installed.get(ctx)
  if (found !== undefined) return found

  if (ctx.get('typert') === undefined) {
    const dispose = (): void => {}
    ctx.provide('typert', {
      lookups: { configure: () => dispose },
      contexts: { configureHost: () => dispose },
    } as never)
  }
  if (ctx.get('agentDefaultModel') === undefined) {
    ctx.provide('agentDefaultModel', {
      currentSelection: defaults.defaultModelSelection,
      saveSelection: async (selection: AgentModelSelection) => {
        await defaults.saveDefaultModelSelection?.(selection)
      },
    } as never)
  }
  if (ctx.get('llm') === undefined) {
    ctx.provide('llm', {
      listProviders: () => {
        const selection = defaults.defaultModelSelection()
        return [{ id: selection.provider, name: selection.provider }]
      },
    } as never)
  }
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(defaults.cwd)
  let controller: SessionController
  try {
    controller = new SessionController(ctx, defaults.coldBlankProbeMaxBytes === undefined
      ? {}
      : { coldBlankProbeMaxBytes: defaults.coldBlankProbeMaxBytes })
  } finally {
    cwd.mockRestore()
  }
  installed.set(ctx, controller)
  return controller
}

/** Build or return the production Session Controller for a direct unit harness. */
export function createSessionTestController(
  ctx: Context,
  defaults: TestSessionRemoteDefaults,
): SessionController {
  return installControllers(ctx, defaults)
}

function remoteResult<T>(
  operation: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<RemoteResult<T>> {
  return Promise.resolve()
    .then(operation)
    .then(value => ({ ok: true as const, value }))
    .catch((error: unknown) => ({
      ok: false as const,
      error: signal?.aborted === true
        ? { code: 'cancelled', message: 'request was aborted', details: {} }
        : error instanceof TypertRemoteFailure
          ? error.failure
          : {
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
            details: {},
          },
    }))
}

/** Build the generated Session Remote's unary result semantics without a carrier. */
export function createSessionTestRemote(
  ctx: Context,
  defaults: TestSessionRemoteDefaults,
): TestSessionRemote {
  const direct = createSessionTestController(ctx, defaults)
  return {
    list: (request, signal = new AbortController().signal) => remoteResult(
      () => direct.list(request, signal),
      signal,
    ),
    search: (request, signal = new AbortController().signal) => remoteResult(
      () => direct.search(request, signal),
      signal,
    ),
    create: request => remoteResult(() => direct.create(request)),
    models: request => remoteResult(() => direct.models(request)),
    selectModel: request => remoteResult(() => direct.selectModel(request)),
    rename: request => remoteResult(() => direct.rename(request)),
    fork: request => remoteResult(() => direct.fork(request)),
    prompt: (request, signal = new AbortController().signal) => remoteResult(
      () => direct.prompt(request, signal),
      signal,
    ),
    attachment: request => remoteResult(() => direct.attachment(request)),
    updateQueue: request => remoteResult(() => direct.updateQueue(request)),
    cancel: request => remoteResult(() => direct.cancel(request)),
    page: (request, signal = new AbortController().signal) => remoteResult(
      () => direct.page(request, signal),
      signal,
    ),
    control: (signal = new AbortController().signal) => direct.control(signal),
  }
}
