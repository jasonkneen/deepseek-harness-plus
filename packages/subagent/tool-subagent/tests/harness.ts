import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as mock from './scripted-provider.ts'
import * as tool from '../src/index.ts'

/** Shared non-aborted tool signal for package-local integration tests. */
export const testToolSignal = new AbortController().signal

/** Build the minimal parent Agent owned by the package-local scripted provider. */
export function fakeAgent(id = 'parent-1'): Agent {
  const sessionId = SessionId(id)
  return { id: sessionId, options: {}, session: Session.create(sessionId) } as unknown as Agent
}

/** Mount the real tool and service stack around one scripted subagent provider. */
export async function setup(toolConfig: tool.Config, mockConfig: Partial<mock.Config> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  await mock.mountScriptedProvider(ctx, { name: 'mock', ...mockConfig })
  await ctx.plugin(tool, toolConfig)
  return ctx
}

let callCounter = 0

/** Execute the registered subagent tool through the real ToolRuntime pipeline. */
export function callSubagent(
  ctx: Context,
  args: unknown,
  over: { agent?: Agent | undefined; signal?: AbortSignal } = {},
) {
  // Distinguish "no override" (use a default agent) from an explicit
  // `{ agent: undefined }` (test the no-agent path). Under
  // exactOptionalPropertyTypes the key is omitted rather than set to undefined.
  const agent = 'agent' in over ? over.agent : fakeAgent()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name: 'subagent',
    arguments: args,
    ...agent ? { agent } : {},
    ...over.signal ? { signal: over.signal } : {},
  })
}

/** Join text blocks from one rendered tool result. */
export function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}
