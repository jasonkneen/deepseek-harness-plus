import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { SessionControlController } from '../src/control.ts'

async function harness(): Promise<{
  ctx: Context
  control: SessionControlController
  agent: Agent
  inbox: Inbox
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create(SessionId('queue-session'))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const agent = { id: session.id, session, inbox, status: 'running', ctx } as Agent
  ctx.agents.register(agent)
  return { ctx, control: new SessionControlController(ctx), agent, inbox }
}

function message(text: string, source: 'user' | 'plugin' = 'user') {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: source === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'fixture' },
  })
}

describe('Session control queue projection', () => {
  it('projects both pending lists in baselines and live replacement frames', async () => {
    const { control, inbox } = await harness()
    const queued = message('queued')
    const steering = message('steering')
    const context = message('context', 'plugin')
    inbox.append('next-turn', queued)
    inbox.append('next-step', steering)
    inbox.append('next-step', context)

    const abort = new AbortController()
    const iterator = control.control(abort.signal)[Symbol.asyncIterator]()
    const opened = await iterator.next()
    expect(opened.value).toMatchObject({
      type: 'baseline',
      value: {
        queues: {
          'queue-session': [
            { id: queued.id, placement: 'queued' },
            { id: steering.id, placement: 'steering' },
            { id: context.id, placement: 'context' },
          ],
        },
      },
    })

    const replacement = message('replacement')
    inbox.append('next-turn', replacement)
    const replaced = await iterator.next()
    if (replaced.done || replaced.value.type !== 'queue') throw new Error('missing queue replacement')
    expect(replaced.value.items.map(item => item.id)).toContain(replacement.id)
    inbox.remove(steering.id)
    const removed = await iterator.next()
    if (removed.done || removed.value.type !== 'queue') throw new Error('missing queue replacement')
    expect(removed.value.items.map(item => item.id)).not.toContain(steering.id)

    abort.abort()
    await iterator.next()
  })

  it('derives queue replacements from the completed projection regardless of registration order', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const control = new SessionControlController(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create(SessionId('late-projection-queue'))
    const agent = { id: session.id, session, inbox: undefined as never, status: 'running', ctx } as unknown as Agent
    Object.assign(agent, { inbox: new Inbox(ctx, agent.session, agentEvents(ctx, agent)) })
    ctx.agents.register(agent)
    const abort = new AbortController()
    const iterator = control.control(abort.signal)[Symbol.asyncIterator]()
    await iterator.next()
    const pending = message('late projection')

    agent.inbox.append('next-turn', pending)

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'projection',
        key: 'inbox',
        value: { 'next-turn': [{ id: pending.id }], 'next-step': [] },
      },
    })
    await expect(nextQueueFrame(iterator)).resolves.toMatchObject({
      items: [{ id: pending.id, placement: 'queued' }],
    })

    abort.abort()
    await iterator.next()
  })

  it('ignores inbox events without the exact live Agent session', async () => {
    const { ctx, control, agent, inbox } = await harness()
    const abort = new AbortController()
    const iterator = control.control(abort.signal)[Symbol.asyncIterator]()
    await iterator.next()

    const unrelated = ctx.sessions.create(SessionId('unrelated-queue'))
    unrelated.append('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [message('unrelated')],
    })
    const replacement = ctx.sessions.create(SessionId('replacement-session'))
    Object.defineProperty(agent, 'session', { configurable: true, value: replacement })
    inbox.append('next-turn', message('wrong-session'))

    abort.abort()
    await iterator.next()
  })

  it('drops broadcasts after cancellation has ended its queue', async () => {
    const { control, inbox } = await harness()
    const abort = new AbortController()
    const iterator = control.control(abort.signal)[Symbol.asyncIterator]()
    await iterator.next()
    const waiting = iterator.next()
    await Promise.resolve()

    abort.abort()
    inbox.append('next-turn', message('late'))

    await expect(waiting).resolves.toMatchObject({ done: true })
  })

  it('ends active streams on context disposal after flushing buffered frames', async () => {
    const { ctx, control, inbox } = await harness()
    const iterator = control.control(new AbortController().signal)[Symbol.asyncIterator]()
    await iterator.next()
    inbox.append('next-turn', message('first'))
    inbox.append('next-turn', message('second'))

    const first = await iterator.next()
    expect(first).toMatchObject({ done: false, value: { type: 'queue' } })
    await ctx.fiber.dispose()
    const second = await iterator.next()
    expect(second).toMatchObject({ done: false, value: { type: 'queue' } })
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })
})
