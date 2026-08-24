/** Slash-menu props for the Conversation-owned input overlay. */
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MenuState } from '../core/contract.ts'

/** Injected business face of the MenuView overlay entry (copy rides the standard locale seat, not this face). */
export interface MenuViewInjected {
  /** The service's menu state store (read-only here; MenuView subscribes). */
  menu: SnapshotStore<MenuState>
  /**
   * Pointer pick routed back through the service pipeline.
   * @param source - source (group) name.
   * @param index - candidate index within the group.
   */
  onPick: (source: string, index: number) => void
  /** Dismiss the menu (external pointer outside the composer area). */
  onDismiss: () => void
}
