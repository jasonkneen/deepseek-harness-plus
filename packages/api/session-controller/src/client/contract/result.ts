/** Client operation results spanning Session Remote calls and the legacy subagent carrier. */

import type { RpcError } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionError } from '../../types.ts'

/** Failure surfaced by the Client Session object layer. */
export type ClientFailure = RpcError | SessionError

/** Success or failure returned by a Client Session operation. */
export type ClientResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ClientFailure }

/**
 * Fold a rejected carrier operation into the Client Session failure vocabulary.
 * @param error - rejection from a legacy subagent or local carrier call.
 * @returns the failure branch of a Client Session result.
 */
export function transportResult<T>(error: unknown): ClientResult<T> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}
