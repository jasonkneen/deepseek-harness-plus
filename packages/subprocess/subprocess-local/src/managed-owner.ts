/** Minimal managed-range ownership bound to one ordinary subprocess handle. */

import type { ChildProcess } from 'node:child_process'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/** Platform owner used by termination and whole-range settlement. */
export interface BoundProcessOwner {
  /** Signal the established managed range; a confirmed-stopped owner stays inert. */
  signal(signal: NodeJS.Signals): void
  /** Wait for the same managed range to become empty; reject when its owner cannot be observed. */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

/** Platform launch facts consumed by the common stdio and result lifecycle. */
export interface ManagedProcessLaunch {
  child: ChildProcess
  pid: number
  direct: Promise<SubprocessOutcome>
  closed: Promise<void>
  owner: BoundProcessOwner
}

/**
 * Observe wrapper close from the moment it is spawned.
 * @param child - direct child or native wrapper.
 * @returns promise settled by the ChildProcess close event.
 */
export function observeChildClose(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => { child.once('close', () => { resolve() }) })
}

/**
 * Apply an optional abort bound to one shared wait promise.
 * @param pending - authoritative platform wait.
 * @param signal - optional caller bound.
 * @returns true on completion, false when the bound aborts first.
 */
export async function waitWithAbort(pending: Promise<void>, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false
  if (signal === undefined) {
    await pending
    return true
  }
  const aborted = Promise.withResolvers<boolean>()
  const onAbort = (): void => { aborted.resolve(false) }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  try {
    return await Promise.race([pending.then(() => true), aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
