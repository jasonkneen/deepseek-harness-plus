import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it } from 'vitest'
import { ProjectedInbox } from '../src/inbox.ts'

function stubAgent(rawId: string, overrides: Partial<Agent> = {}): Agent {
  const id = SessionId(rawId)
  const session = overrides.session ?? Session.create(id)
  const ctx = overrides.ctx ?? new Context()
  return {
    id,
    options: {},
    session,
    inbox: { nextTurn: [], nextStep: [] } as never,
    status: 'idle',
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
    ...overrides,
  }
}

async function inboxAgent(rawId: string): Promise<{ ctx: Context; session: Session; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create(SessionId(rawId))
  const agent = stubAgent(rawId, { ctx, session })
  Object.assign(agent, {
    inbox: new ProjectedInbox(ctx.sessionProjections, session, agentEvents(ctx, agent)),
  })
  return { ctx, session, agent }
}

describe('ProjectedInbox', () => {
  it('reports a missing inbox projection as a composition error', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    const agent = stubAgent('missing-inbox-projection', { ctx })
    const inbox = new ProjectedInbox(
      ctx.sessionProjections,
      agent.session,
      agentEvents(ctx, agent),
    )

    expect(() => inbox.nextTurn).toThrow(
      'agent "missing-inbox-projection" cannot read inbox state: session projection "inbox" is not registered; load AgentRegistry with SessionProjectionRegistry before constructing ReactLoopAgent',
    )
  })

  it('replaces a pending message by identity across both lists', async () => {
    const { ctx, agent } = await inboxAgent('replace-inbox')
    const inserted: UserMessage[] = []
    const discarded: UserMessage[] = []
    ctx.on('agent/inbox/inserted', ({ message }) => void inserted.push(message))
    ctx.on('agent/inbox/discarded', ({ message }) => void discarded.push(message))
    const { inbox } = agent
    const original = createUserMessage({
      content: [{ type: 'text', text: 'original' }],
      source: { kind: 'user' },
    })
    const nextStep = createUserMessage({
      content: [{ type: 'text', text: 'step' }],
      source: { kind: 'user' },
    })
    const replacement = createUserMessage({
      content: [{ type: 'text', text: 'replacement' }],
      source: { kind: 'user' },
    })
    const editedStep = freezeMessage({
      ...nextStep,
      content: [{ type: 'text', text: 'edited step' }],
    })
    inbox.append('next-turn', original)
    inbox.append('next-step', nextStep)

    expect(inbox.replace(createUserMessage({
      content: [{ type: 'text', text: 'missing' }],
      source: { kind: 'user' },
    }).id, replacement)).toBe(false)
    expect(inbox.replace(original.id, replacement)).toBe(true)
    expect(inbox.replace(nextStep.id, editedStep)).toBe(true)
    expect(inbox.nextTurn).toEqual([replacement])
    expect(inbox.nextStep).toEqual([editedStep])
    expect(discarded).toEqual([original, nextStep])
    expect(inserted).toEqual([original, nextStep, replacement, editedStep])
    expect(() => { inbox.replace(editedStep.id, replacement) })
      .toThrow(`message "${replacement.id}" is already pending`)
  })

  it('normalizes splice coordinates, rejects duplicate identities, and reports missing removals', async () => {
    const { agent } = await inboxAgent('splice-inbox')
    const { inbox } = agent
    const first = createUserMessage({
      content: [{ type: 'text', text: 'first' }],
      source: { kind: 'user' },
    })
    const second = createUserMessage({
      content: [{ type: 'text', text: 'second' }],
      source: { kind: 'user' },
    })
    const prefixed = createUserMessage({
      content: [{ type: 'text', text: 'prefixed' }],
      source: { kind: 'user' },
    })

    inbox.splice('next-turn', Number.NaN, Number.NaN, [first, second])
    expect(inbox.nextTurn).toEqual([first, second])
    expect(inbox.splice('next-turn', -1, 1, [])).toEqual([second])
    inbox.prepend('next-turn', prefixed)
    expect(inbox.nextTurn).toEqual([prefixed, first])
    expect(inbox.remove(second.id)).toBe(false)
    expect(() => { inbox.append('next-step', first) }).toThrow(`message "${first.id}" is already pending`)
  })

  it('clears both pending lists as durable cancellations', async () => {
    const { ctx, session, agent } = await inboxAgent('clear-inbox')
    const discarded: UserMessage[] = []
    ctx.on('agent/inbox/discarded', ({ message }) => void discarded.push(message))
    const { inbox } = agent
    const nextTurn = createUserMessage({ content: [{ type: 'text', text: 'turn' }], source: { kind: 'user' } })
    const nextStep = createUserMessage({ content: [{ type: 'text', text: 'step' }], source: { kind: 'user' } })
    inbox.append('next-turn', nextTurn)
    inbox.append('next-step', nextStep)
    const beforeClear = session.events.length

    inbox.clear()

    expect(inbox.nextTurn).toEqual([])
    expect(inbox.nextStep).toEqual([])
    expect(discarded).toEqual([nextStep, nextTurn])
    expect(session.events.slice(beforeClear).map(event => event.type === 'agent/inbox/spliced'
      ? event.data
      : event.type)).toEqual([
      { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
      { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
    ])

    inbox.clear()
    expect(session.events).toHaveLength(beforeClear + 2)
  })
})
