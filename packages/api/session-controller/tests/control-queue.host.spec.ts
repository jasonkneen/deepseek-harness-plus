import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it } from 'vitest'
import { SessionControlController } from '../src/control.ts'
import type { SessionControlFrame } from '../src/types.ts'
import { createInboxFixture } from '@deepseek-ai/dsh-agent-loop-testkit'

async function harness(): Promise<{
  ctx: Context
  control: SessionControlController
  agent: Agent
  inbox: Inbox
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create(SessionId('queue-session'))
  const agent = { id: session.id, session, inbox: undefined as never, status: 'running', ctx } as unknown as Agent
  Object.assign(agent, { inbox: createInboxFixture(ctx.sessionProjections, session).inbox })
  ctx.agents.register(agent)
  return { ctx, control: new SessionControlController(ctx), agent, inbox: agent.inbox }
}

function message(text: string, source: 'user' | 'plugin' = 'user') {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: source === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'fixture' },
  })
}

describe('Session control queue projection', () => {
  /** Consume frames until the next queue replacement (inbox projection frames interleave). */
  async function nextQueueFrame(
    iterator: AsyncIterator<SessionControlFrame>,
  ): Promise<Extract<SessionControlFrame, { type: 'queue' }>> {
    for (;;) {
      const next = await iterator.next()
      if (next.done) throw new Error('stream ended before a queue frame')
      if (next.value.type === 'queue') return next.value
    }
  }

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
    const replaced = await nextQueueFrame(iterator)
    expect(replaced.items.map(item => item.id)).toContain(replacement.id)
    inbox.remove(steering.id)
    const removed = await nextQueueFrame(iterator)
    expect(removed.items.map(item => item.id)).not.toContain(steering.id)

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
    Object.assign(agent, { inbox: createInboxFixture(ctx.sessionProjections, session).inbox })
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
    const first = message('first')
    const second = message('second')
    inbox.append('next-turn', first)
    inbox.append('next-turn', second)

    const queues: Extract<SessionControlFrame, { type: 'queue' }>[] = []
    await ctx.fiber.dispose()
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      if (next.value.type === 'queue') queues.push(next.value)
    }
    expect(queues.map(queue => queue.items.map(item => item.id))).toEqual([[first.id], [first.id, second.id]])
  })
})
