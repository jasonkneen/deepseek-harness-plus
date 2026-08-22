/** Minimal managed-range ownership bound to one ordinary subprocess handle. */

import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/** Direct target started, but its runner closed before publishing an exit event. */
export class DirectResultUnavailableError extends Error {
  override name = 'DirectResultUnavailableError'
}

/** Platform owner used by termination and whole-range settlement. */
export interface BoundProcessOwner {
  /** Signal the established managed range; a confirmed-stopped owner stays inert. */
  signal(signal: 'SIGTERM' | 'SIGKILL'): void
  /** Wait for the same managed range to become empty; reject when its owner cannot be observed. */
  waitForExit(): Promise<void>
}

/** Platform launch facts consumed by the common stdio and result lifecycle. */
export interface ManagedProcessLaunch {
  stdin: Writable | null
  stdout: Readable | null
  stderr: Readable | null
  pid: number
  direct: Promise<SubprocessOutcome>
  owner: BoundProcessOwner
}

/**
 * Observe runner exit separately from inherited stdio closure.
 * @param child - native wrapper process.
 * @returns promises for wrapper exit/error and full stdio closure.
 */
export function observeChildLifecycle(child: ChildProcess): {
  exited: Promise<void>
  closed: Promise<void>
} {
  const exited = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  child.once('error', () => {
    // runnerDirectResult reports the wrapper failure through the handle.
    exited.resolve()
  })
  child.once('exit', () => { exited.resolve() })
  child.once('close', () => {
    exited.resolve()
    closed.resolve()
  })
  return { exited: exited.promise, closed: closed.promise }
}

/**
 * Apply an optional abort bound to one shared wait promise.
 * @param pending - authoritative platform wait.
 * @param signal - optional caller bound.
 * @returns true on completion, false when the bound aborts first.
 */
export async function waitWithAbort(pending: Promise<void>, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    void pending.catch(() => {
      // This caller declined the wait; a later caller still observes the cached rejection.
    })
    return false
  }
  if (signal === undefined) {
    await pending
    return true
  }
  const aborted = Promise.withResolvers<boolean>()
  const onAbort = (): void => { aborted.resolve(false) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending.then(() => true), aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
