import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createInboxFixture, mountAgentLoopTestDependencies } from '../src/index.ts'

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('dsh-agent-loop-testkit', () => {
  it('mounts a configurable prerequisite spine that can activate AgentLoop', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, {
      systemPrompt: { persona: 'Test persona.' },
      tools: { mode: 'native' },
    })
    await ctx.plugin(SessionProjectionRegistry)

    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Test persona.')
    await expect(ctx.plugin(AgentLoop, { agents: [] })).resolves.toBeDefined()

    await ctx.fiber.dispose()
  })

  it('provides a session-backed structural Inbox with separate driver claims', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create(SessionId('agent-loop-testkit-inbox'))
    const fixture = createInboxFixture(ctx.sessionProjections, session)
    const firstTurn = message('first turn')
    const secondTurn = message('second turn')
    const firstStep = message('first step')
    const editedTurn = message('edited turn')
    const editedStep = message('edited step')

    fixture.inbox.append('next-turn', firstTurn)
    fixture.inbox.prepend('next-turn', secondTurn)
    fixture.inbox.append('next-step', firstStep)
    expect(fixture.inbox.nextTurn).toEqual([secondTurn, firstTurn])
    expect(fixture.inbox.nextStep).toEqual([firstStep])

    expect(fixture.inbox.replace(firstTurn.id, editedTurn)).toBe(true)
    expect(fixture.inbox.replace(firstStep.id, editedStep)).toBe(true)
    expect(fixture.inbox.replace(firstTurn.id, message('missing replacement'))).toBe(false)
    expect(fixture.inbox.remove(firstTurn.id)).toBe(false)
    expect(fixture.inbox.splice('next-turn', -1, 1, [])).toEqual([editedTurn])
    expect(fixture.inbox.remove(editedStep.id)).toBe(true)

    const claimedStep = message('claimed step')
    const claimedTurn = message('claimed turn')
    fixture.inbox.splice('next-step', Number.NaN, Number.NaN, [claimedStep])
    fixture.inbox.append('next-turn', claimedTurn)
    expect(fixture.claim('next-step')).toEqual([claimedStep])
    expect(fixture.claim('next-turn')).toEqual([secondTurn])
    expect(fixture.inbox.nextTurn).toEqual([claimedTurn])

    const eventCount = session.events.length
    expect(fixture.inbox.splice('next-step', 100, -1, [])).toEqual([])
    expect(session.events).toHaveLength(eventCount)

    fixture.inbox.clear()
    expect(fixture.inbox.nextTurn).toEqual([])
    expect(fixture.inbox.nextStep).toEqual([])
    fixture.inbox.clear()

    await ctx.fiber.dispose()
  })

  it('registers the standard inbox projection for a standalone fixture', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    const session = Session.create(SessionId('agent-loop-testkit-standalone-inbox'))
    const fixture = createInboxFixture(
      ctx.sessionProjections,
      session,
    )

    expect(fixture.inbox.nextStep).toEqual([])
    expect(ctx.sessionProjections.snapshot(session).values.inbox).toEqual({
      'next-turn': [],
      'next-step': [],
    })

    await ctx.fiber.dispose()
  })
})
