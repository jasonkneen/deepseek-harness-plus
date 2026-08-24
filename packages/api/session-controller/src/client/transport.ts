/** Session-specific adapters for Gateway-owned Remote stream lifecycles. */

import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import {
  RemoteJournalStream,
  RemoteSnapshotStream,
  RemoteStreamCarrierError,
  RemoteStreamError,
  type ClientRemote,
  type RemoteJournalChange,
  type RemoteJournalFrame,
} from '@deepseek-ai/dsh-api-gateway/client'
import type {
  SessionAddress,
  SessionControlFrame,
  SessionEventEntry,
  SessionPage,
  SessionPageRequest,
} from '../types.ts'

export {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from '../types.ts'

/** Pagination fields bound to an already-addressed Session journal. */
export type ClientSessionPageRequest = Omit<SessionPageRequest, 'address' | 'throughSeq'>

/** Complete generated `ctx.remote.session` namespace. */
export type SessionRemote = ClientRemote['session']

/** One complete publication from the Session journal stream. */
export type SessionJournalChange = RemoteJournalChange<SessionPage, SessionEventEntry>

type SessionControlBaselineFrame = Extract<SessionControlFrame, { type: 'baseline' }>
type SessionControlDeltaFrame = Exclude<SessionControlFrame, SessionControlBaselineFrame>

/** Gateway-owned control snapshot stream configured for Session frames. */
export type SessionControlStream = RemoteSnapshotStream<
  SessionControlBaselineFrame,
  SessionControlDeltaFrame
>

type SessionStreamRemote = Pick<ClientRemote, '$stream' | 'session'>

/** Domain sinks used by the Host-wide Session control stream. */
export interface SessionControlStreamOptions {
  /** Apply a complete baseline or one later update. */
  readonly accept: (frame: SessionControlFrame) => void
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** Publish a terminal business or protocol failure. */
  readonly failed: (error: unknown) => void
}

/** Domain sinks used by one addressed Session event journal. */
export interface SessionEventStreamOptions {
  /** Apply one complete event-window change. */
  readonly publish: (change: SessionJournalChange) => void
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** Publish a terminal stream, page, or protocol failure after opening. */
  readonly failed: (error: unknown) => void
}

/**
 * Create the Host-wide Session control snapshot stream.
 * @param remote - generated Session namespace and Gateway stream factory.
 * @param options - Session state destinations.
 * @returns an unstarted stream owned by the Client Session runtime.
 */
export function createSessionControlStream(
  remote: SessionStreamRemote,
  options: SessionControlStreamOptions,
): SessionControlStream {
  const stream = remote.$stream<SessionControlFrame>({
    name: 'session control stream',
    open: signal => remote.session.control(signal),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('session control stream ended without a terminal result')
      : new Error('session control stream ended before its opening snapshot'),
    ...(options.carrierFailed === undefined ? {} : { carrierFailed: options.carrierFailed }),
  })
  return new RemoteSnapshotStream(stream, {
    name: 'session control stream',
    isSnapshot: (frame): frame is SessionControlBaselineFrame => frame.type === 'baseline',
    replace: options.accept,
    update: options.accept,
    failed: options.failed,
  })
}

/** Gateway-owned event journal bound to one ordinary or direct-subagent Session address. */
export class SessionEventStream extends RemoteJournalStream<
  SessionPage,
  SessionEventEntry,
  number,
  ClientSessionPageRequest
> {
  /**
   * @param remote - generated Session namespace and Gateway stream factory.
   * @param address - durable ordinary-Session or direct-subagent address.
   * @param options - Session event-window destinations.
   */
  constructor(
    private readonly remote: SessionStreamRemote,
    private readonly address: SessionAddress,
    options: SessionEventStreamOptions,
  ) {
    super(remote, {
      name: 'session event stream',
      emptyCursor: -1,
      entries: page => page.events,
      hasMore: page => page.hasMore,
      cursor: entry => entry.event.seq,
      compare: (left, right) => left - right,
      follows: (left, right) => right === left + 1,
      publish: options.publish,
      ...(options.carrierFailed === undefined
        ? {}
        : { carrierFailed: options.carrierFailed }),
      failed: options.failed,
    })
  }

  /** @inheritdoc */
  protected override async * follow(
    afterSeq: number | undefined,
    signal: AbortSignal,
  ): AsyncIterable<RemoteJournalFrame<SessionEventEntry, number>> {
    const request = afterSeq === undefined
      ? { address: this.address }
      : { address: this.address, afterSeq }
    for await (const frame of this.remote.session.follow(request, signal)) {
      if (frame.type === 'opened') {
        yield frame
        continue
      }
      const { type: _type, ...entry } = frame
      yield { type: 'entry', entry }
    }
  }

  /** @inheritdoc */
  protected override async readPage(
    request: ClientSessionPageRequest,
    throughSeq: number,
    signal: AbortSignal,
  ): Promise<SessionPage> {
    const result = await this.remote.session.page(
      { address: this.address, throughSeq, ...request },
      signal,
    )
    if (!result.ok) {
      throw new RemoteStreamError(
        result.error.code,
        result.error.message,
        result.error.details,
      )
    }
    return result.value
  }

  /** @inheritdoc */
  protected override repairRequest(
    request: ClientSessionPageRequest,
  ): ClientSessionPageRequest {
    return request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }
  }
}

/**
 * Recover a Host Session failure from a Remote stream terminal error.
 * @param error - value thrown while opening or consuming a Session stream.
 * @returns the Host failure, or `undefined` for carrier and local failures.
 */
export function sessionStreamFailure(error: unknown): RemoteFailure | undefined {
  if (!(error instanceof RemoteStreamError)) return undefined
  return { code: error.code, message: error.message, details: error.details }
}
