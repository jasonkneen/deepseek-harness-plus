import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { unsupportedInbox, mountAgentLoopTestDependencies } from '../src/index.ts'

describe('dsh-agent-loop-testkit', () => {
  it('rejects mutations through an unsupported Agent stub Inbox', () => {
    const inbox = unsupportedInbox()

    expect(inbox.nextTurn).toEqual([])
    expect(inbox.nextStep).toEqual([])
    expect(() => { inbox.clear() }).toThrow('this test Agent does not support Inbox mutations')
  })

  it('mounts a configurable prerequisite spine that can activate AgentLoop', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, {
      systemPrompt: { persona: 'Test persona.' },
      tools: { mode: 'native' },
    })

    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Test persona.')
    await expect(ctx.plugin(AgentLoop, { agents: [] })).resolves.toBeDefined()

    await ctx.fiber.dispose()
  })
})
