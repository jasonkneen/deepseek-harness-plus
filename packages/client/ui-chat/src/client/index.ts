/** Browser Chat target plugin. */
export { apply, inject } from './apply.ts'
export type {} from './conversation-nodes/assistant.ts'
export type {} from './conversation-nodes/command.ts'
export type {} from './conversation-nodes/compaction.ts'
export type {} from './conversation-nodes/fallback.ts'
export type {} from './conversation-nodes/message.ts'
export type {} from './conversation-nodes/retry.ts'
export type {} from './conversation-nodes/tool.ts'
export type {} from './conversation-nodes/turn-error.ts'
export type {} from './conversation-nodes/turn-max-tokens.ts'
export type {} from './conversation-nodes/turn-tail.ts'

export type {
  AssistantBlock, AssistantMessageNode, AssistantProvenanceView, AssistantRequestConfig,
  AssistantTiming, ChatLocationNodeIndex, ChatNodeStore, ChatSnapshot, CommandNode,
  CompactionSummaryNode, ContextMessageNode, ConversationNode, LegacyConversationSlice,
  ModelRetryNode, PartialAssistant, RunningToolCall, SteeringMessageNode, ToolCallBlock,
  ToolResultNode, TurnErrorNode, TurnMaxTokensNode, UnknownSurfaceNode, UserMessageNode,
} from './contract/snapshot.ts'
export type {
  AssistantChatData, ChatConversationViewNode, ChatNode, ChatNodeKind,
  FinalAssistantChatData, ManualCompactionChatData, RetryChatData, ToolChatData,
  TurnTailChatData,
} from './contract/chat-nodes.ts'
export type { CallId, ChatStoreState, SelectionTarget } from './contract/store.ts'
export type {
  AssistantActionOwnerProps, ChatFileMentions, ChatNodeOwnerProps, ChatNodeTurnDataInjected,
  ChatNodeViewProps, ChatScrollPosition, ChatStore, ChatViewInjected, ChatViewSlotProps,
  CommandRowOwnerProps, CommandRowProps, DetailsInjected, DetailsSlotProps,
  DetailsToolOwnerProps, MessageImagesOwnerProps, MessageImagesProps, RenderMessageImages,
  TurnTailOwnerProps, UseChat, UseChatNodeTurnData,
} from './contract/slots.ts'
export type { ChatKey } from './locale.ts'
export type { ConversationContext, ConversationContextOriginKind } from './model/conversation-context.ts'
export type {
  ContextProvenanceView, ContextRole, KnownContextForm,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
export type {
  ConversationPromptSnapshot, RequestInspectionSnapshot, RequestPromptChange, RequestView,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

export { isRunningTool, isSettledTool } from './contract/chat-nodes.ts'
export { EMPTY_CHAT_SNAPSHOT } from './contract/snapshot.ts'

/** Public merge surface for Chat renderer payloads contributed by other plugins. */
export interface ChatNodeDataMap {}

type PublicChatNodeDataMap = ChatNodeDataMap

declare module './contract/chat-nodes.ts' {
  interface ChatNodeDataMap extends PublicChatNodeDataMap {}
}
