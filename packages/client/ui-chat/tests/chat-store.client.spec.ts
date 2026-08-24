import { describe, expect, it } from 'vitest'
import { createChatStore } from '../src/client/stores.ts'

describe('createChatStore', () => {
  it('starts without a selected Chat target', () => {
    const store = createChatStore().create()
    expect(store.store.getSnapshot()).toEqual({ selection: null })
  })

  it('selects and clears one Chat details target', () => {
    const store = createChatStore().create()
    store.actions.select({ turnSeq: 3, callId: 'c1', toolName: 'bash' })
    expect(store.store.getSnapshot().selection)
      .toEqual({ turnSeq: 3, callId: 'c1', toolName: 'bash' })
    store.actions.select(null)
    expect(store.store.getSnapshot().selection).toBeNull()
  })

  it('creates independent instances', () => {
    const handle = createChatStore()
    const first = handle.create()
    const second = handle.create()
    first.actions.select({ turnSeq: 1 })
    expect(second.store.getSnapshot().selection).toBeNull()
  })
})
