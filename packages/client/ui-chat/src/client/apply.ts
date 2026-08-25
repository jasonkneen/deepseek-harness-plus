/** Register the Chat Conversation target, renderers, stats, and details surface. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { BoundActions, ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
// Type-only service and declaration merges used by the apply world.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {
  ChatNodeTurnDataInjected, ChatScrollPosition, ChatViewInjected, DetailsInjected,
  TurnTailOwnerProps,
} from './contract/slots.ts'
import type { ChatSnapshot } from './contract/snapshot.ts'
import { EMPTY_CHAT_SNAPSHOT } from './contract/snapshot.ts'
import { ApprovalCommand } from './chat/ApprovalCommand.tsx'
import { ChatView } from './chat/ChatView.tsx'
import { registerChatNodeRenderers } from './chat/register-node-renderers.ts'
import { StatsLine } from './chat/StatsLine.tsx'
import { registerConversationNodes } from './conversation-nodes/register.ts'
import { DetailsPanel } from './details/DetailsPanel.tsx'
import { en, NS, zh } from './locale.ts'
import { createChatStore } from './stores.ts'

const CHAT_NODE_INJECT: ChatNodeTurnDataInjected = {
  hooks: {
    turnData: ({ useChat }, nodeKey) => function useTurnData(key) {
      return useChat((snapshot) => {
        const location = snapshot.nodes.get(nodeKey)?.location
        return location?.kind === 'turn' || location?.kind === 'step'
          ? location.turn.data.get(key)
          : undefined
      })
    },
  },
}

/** Services required by the Chat target and its presentation registrations. */
export const inject = [
  'slots', 'sessions', 'uiSession', 'uiConversation', 'uiWorkspace', 'layout', 'locale',
]

/**
 * Mount all Chat-owned contributions.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  const chatSources = new WeakMap<SessionBinding, ObservableSnapshot<ChatSnapshot>>()
  const chatSource = (binding: SessionBinding): ObservableSnapshot<ChatSnapshot> => {
    let source = chatSources.get(binding)
    if (source === undefined) {
      const target = ctx.uiConversation.binding(binding).target('chat')
      source = {
        getSnapshot: () => target.getSnapshot() ?? EMPTY_CHAT_SNAPSHOT,
        subscribe: listener => target.subscribe(listener),
      }
      chatSources.set(binding, source)
    }
    return source
  }
  registerConversationNodes(ctx)
  registerChatNodeRenderers(ctx)
  ctx.uiSession.provide({
    hooks: ['chat'],
    resolve: binding => ({ hooks: { chat: chatSource(binding) } }),
  })

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-chat: dictionaries')
  const t = ctx.locale.bind(NS)
  const chatStore = createChatStore()
  const chatScrollPositions = new Map<SessionId, ChatScrollPosition>()

  ctx.slots.inject('conversation.view', () => {
    const disposeView = ctx.slots.register({
      name: 'conversation.view',
      id: 'chat',
      order: 0,
      label: () => t('view.chat'),
      locale: NS,
      children: {
        'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: CHAT_NODE_INJECT },
        'conversation.message.images': { kind: 'single', scope: 'session' },
      },
      store: chatStore,
      inject: (sessionId: SessionId, actions: BoundActions<typeof chatStore>): ChatViewInjected => {
        const session = ctx.sessions.binding(sessionId)?.session
        if (session === undefined) throw new Error(`ui-chat: unknown session "${sessionId}"`)
        return {
          openDetails: (target) => {
            actions.select(target)
            ctx.layout.openDetails()
          },
          fileMentions: (owner: TurnTailOwnerProps) => ctx.get('chatFileMentions')?.forClosing(owner),
          openFile: (path) => {
            const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
            return ctx.uiWorkspace.openPath(resolveWorkspacePath(cwd, path))
          },
          loadOlder: () => { void session.loadOlder() },
          loadImage: attachment => ctx.uiConversation.imageUrl(sessionId, attachment),
          chatScroll: {
            save: (position) => {
              if (position === null) chatScrollPositions.delete(sessionId)
              else chatScrollPositions.set(sessionId, position)
            },
            read: () => chatScrollPositions.get(sessionId) ?? null,
          },
          forkAt: (seq) => {
            ctx.sessions.fork({ sessionId, atSeq: seq, increaseTitle: true })
              .then((childId) => { ctx.sessions.open(childId) })
              .catch(() => {
                // Fork or child-title failure leaves the source view unchanged.
              })
          },
        }
      },
    }, ChatView)
    return disposeView
  })

  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register({
      name: 'conversation.composer.dock', id: 'stats', order: 0, locale: NS,
    }, StatsLine))

  ctx.slots.inject('conversation.approval.detail', () =>
    ctx.slots.register({ name: 'conversation.approval.detail' }, ApprovalCommand))

  ctx.slots.inject('details', () => ctx.slots.register({
    name: 'details',
    locale: NS,
    children: { 'conversation.details.tool': { kind: 'single', scope: 'session' } },
    store: chatStore,
    inject: (): DetailsInjected => ({ closeDetails: () => { ctx.layout.closeDetails() } }),
  }, DetailsPanel))
}
