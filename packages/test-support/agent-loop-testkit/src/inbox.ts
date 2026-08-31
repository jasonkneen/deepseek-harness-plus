import type { Inbox } from '@deepseek-ai/dsh-agent'

/**
 * Create an unsupported Inbox placeholder for Agent stubs whose tests do not exercise Inbox behavior.
 * @returns an Inbox whose pending lists are empty and whose mutation methods throw.
 */
export function unsupportedInbox(): Inbox {
  const rejectMutation = (): never => {
    throw new Error('this test Agent does not support Inbox mutations')
  }
  return {
    nextTurn: [],
    nextStep: [],
    clear: rejectMutation,
    append: rejectMutation,
    prepend: rejectMutation,
    replace: rejectMutation,
    remove: rejectMutation,
    splice: rejectMutation,
  }
}
