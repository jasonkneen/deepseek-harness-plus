// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLayoutStore } from '../src/client/stores.ts'

beforeEach(() => { vi.stubGlobal('innerWidth', 1920) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('createLayoutStore', () => {
  it('starts with the default sidebar and no right panel preference', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual({
      sidebar: 280,
      viewportWidth: 1920,
      narrowExpanded: false,
      rightbar: null,
      rightbarShown: false,
      rightbarTrack: false,
      rightbarFullscreen: false,
    })
  })

  it('creates independent instances without browser persistence', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem')
    const a = createLayoutStore().create()
    const b = createLayoutStore().create()
    a.actions.setSidebar(400)
    a.actions.openRightbar(true, false)
    expect(b.store.getSnapshot().sidebar).toBe(280)
    expect(b.store.getSnapshot().rightbar).toBeNull()
    expect(write).not.toHaveBeenCalled()
  })

  it('clamps the sidebar to 264–420px', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(1)
    expect(store.getSnapshot().sidebar).toBe(264)
    actions.setSidebar(9999)
    expect(store.getSnapshot().sidebar).toBe(420)
  })

  it('toggles the wide sidebar between closed and default width', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(280)
  })

  it('keeps the sidebar preference while toggling its narrow override', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.setViewportWidth(980)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ sidebar: 400, viewportWidth: 980, narrowExpanded: true })
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ sidebar: 400, narrowExpanded: false })
  })

  it('clears the manual override only when crossing 1024px', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(980)
    actions.toggleSidebar()
    actions.setViewportWidth(980)
    actions.setViewportWidth(1023)
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setViewportWidth(1024)
    expect(store.getSnapshot().narrowExpanded).toBe(false)
    actions.setViewportWidth(980)
    expect(store.getSnapshot().narrowExpanded).toBe(false)
  })
})

describe('right panel', () => {
  it('initializes at 45% of the latest frame only on first opening', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(1000)
    expect(store.getSnapshot().rightbar).toBeNull()
    actions.openRightbar(true, false)
    expect(store.getSnapshot().rightbar).toBe(450)
    actions.setViewportWidth(2000)
    actions.openRightbar(true, true)
    expect(store.getSnapshot().rightbar).toBe(450)
    actions.closeRightbar()
    actions.openRightbar(true, false)
    expect(store.getSnapshot().rightbar).toBe(450)
  })

  it('keeps track and fullscreen reports independent and clears both on close', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openRightbar(true, false)
    expect(store.getSnapshot()).toMatchObject({ rightbarShown: true, rightbarTrack: true, rightbarFullscreen: false })
    actions.openRightbar(true, true)
    expect(store.getSnapshot()).toMatchObject({ rightbarShown: true, rightbarTrack: true, rightbarFullscreen: true })
    actions.openRightbar(false, true)
    expect(store.getSnapshot()).toMatchObject({ rightbarShown: true, rightbarTrack: false, rightbarFullscreen: true })
    actions.closeRightbar()
    expect(store.getSnapshot()).toMatchObject({ rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false })
  })

  it('keeps dragged px preferences across resize, close, and reopen', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openRightbar(true, false)
    actions.setRightbar(1100)
    actions.setViewportWidth(800)
    expect(store.getSnapshot().rightbar).toBe(1100)
    actions.closeRightbar()
    actions.openRightbar(false, true)
    expect(store.getSnapshot().rightbar).toBe(1100)
  })

  it('clamps drag preferences to 300px and 70% of the current frame', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(1600)
    actions.setRightbar(9999)
    expect(store.getSnapshot().rightbar).toBe(1120)
    actions.setViewportWidth(1000)
    actions.setRightbar(9999)
    expect(store.getSnapshot().rightbar).toBe(700)
    actions.setRightbar(1)
    expect(store.getSnapshot().rightbar).toBe(300)
  })

  it('retains a minimum normal preference when first opened fullscreen on a phone', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(320)
    actions.openRightbar(false, true)
    expect(store.getSnapshot().rightbar).toBe(300)
  })

  it('collapses a manually expanded narrow sidebar on opening, not presentation reports', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.setViewportWidth(800)
    actions.toggleSidebar()
    actions.openRightbar(true, false)
    expect(store.getSnapshot()).toMatchObject({ sidebar: 400, narrowExpanded: false })
    actions.toggleSidebar()
    actions.openRightbar(true, true)
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.closeRightbar()
    actions.openRightbar(true, false)
    expect(store.getSnapshot().narrowExpanded).toBe(false)
  })

  it('keeps the wide sidebar preference and never opens a closed right panel on resize', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(420)
    actions.openRightbar(true, false)
    expect(store.getSnapshot().sidebar).toBe(420)
    actions.closeRightbar()
    actions.setViewportWidth(3000)
    expect(store.getSnapshot()).toMatchObject({ sidebar: 420, rightbarShown: false, rightbarTrack: false })
  })
})
