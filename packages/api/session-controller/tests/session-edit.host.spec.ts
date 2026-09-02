import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SurfaceIntent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import type { SessionEditRequest, SessionRequestId } from '../src/types.ts'
import { createSessionTestRemote, installSessionReadTestServices } from './test-remote.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

function appendTurn(session: Session, turn: number, prompt: string, answer: string): SessionEvent<'user/message'> {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: answer }],
      source: { provider: 'fixture', model: 'fixture-model' },
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return user
}

async function harness(
  running = false,
  inputModalities: readonly ('text' | 'image')[] | null = ['text', 'image'],
  providers: readonly string[] = ['fixture'],
): Promise<{
  ctx: Context
  controller: SessionCommandController
  agent: Agent
  session: Session
  sent: Array<{
    message: Parameters<Agent['send']>[0]
    followingMessages: readonly Parameters<Agent['send']>[0][]
    intent: SurfaceIntent | undefined
    position: string | undefined
  }>
  cancel: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
  ctx.provide('llm', {
    listProviders: () => providers.map(id => ({ id })),
    resolveModelInfo: () => Promise.resolve(inputModalities === null ? {} : { inputModalities }),
  } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  const session = ctx.sessions.create(SessionId('edit-session'), { meta: { cwd: '/workspace' } })
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: Agent['status'] = running ? 'running' : 'idle'
  let nextTurn = 100
  const sent: Array<{
    message: Parameters<Agent['send']>[0]
    followingMessages: readonly Parameters<Agent['send']>[0][]
    intent: SurfaceIntent | undefined
    position: string | undefined
  }> = []
  const agent = {
    id: session.id,
    options: { provider: 'fixture', model: 'fixture-model' },
    session,
    inbox,
    get status() { return status },
    ctx,
    send(message, _target, _wakeup, options) {
      sent.push({
        message,
        followingMessages: options?.followingMessages ?? [],
        intent: options?.surfaceIntent,
        position: options?.position,
      })
      const turn = nextTurn
      nextTurn += 1
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 1 })
      session.append('user/message', message, options?.surfaceIntent ?? { surfaceOp: 'append' })
      for (const following of options?.followingMessages ?? []) {
        session.append('user/message', following, { surfaceOp: 'append' })
      }
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    },
    followup: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
    cancel: vi.fn(() => {
      status = 'idle'
      ctx.emit('agent/status', { agent, status: 'idle' })
    }),
    runMaintenance: async operation => operation(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } satisfies Agent
  const cancel = vi.mocked(agent.cancel)
  ctx.agents.register(agent)
  const selection: ModelSelectionRef = {
    current: { provider: 'fixture', model: 'fixture-model' },
    assembled: undefined,
  }
  const agents = {
    resolveAgent: () => Promise.resolve({ agent }),
    selectionFor: () => selection,
    serializeImageAdmission: (_agent: Agent, operation: () => Promise<unknown>) => operation(),
  } as unknown as ApiSessionAgentController
  return {
    ctx,
    controller: new SessionCommandController(ctx, agents, '/workspace'),
    agent,
    session,
    sent,
    cancel,
  }
}

function request(
  messageSeq: number,
  expectedLastUserSeq: number,
  text = 'edited',
  clientTimeZone: string | undefined = 'UTC',
): SessionEditRequest {
  return {
    requestId: 'edit-request' as SessionRequestId,
    sessionId: SessionId('edit-session'),
    messageSeq,
    expectedLastUserSeq,
    text,
    ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
  }
}

describe('session.edit', () => {
  it.each([false, true])('replaces the latest turn and prioritizes the rerun (running=%s)', async (running) => {
    const fixture = await harness(running)
    appendTurn(fixture.session, 1, 'first', 'first answer')
    const second = appendTurn(fixture.session, 2, 'second', 'second answer')
    fixture.agent.inbox.append('next-turn', createUserMessage({
      content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' },
    }))

    const result = await fixture.controller.edit(request(second.seq, second.seq), new AbortController().signal)

    expect(result).toMatchObject({ accepted: true })
    expect(fixture.sent).toHaveLength(1)
    expect(fixture.sent[0]).toMatchObject({
      message: { content: [{ type: 'text', text: 'edited' }] },
      position: 'front',
      intent: {
        surfaceOp: { op: 'replace', start: second.seq },
        conversationOp: { op: 'replace', start: second.seq - 2 },
      },
    })
    expect(fixture.session.deriveMessages().map(message => message.content)).toEqual([
      [{ type: 'text', text: 'first' }],
      [{ type: 'text', text: 'first answer' }],
      [{ type: 'text', text: 'edited' }],
    ])
    expect(fixture.cancel).toHaveBeenCalledTimes(running ? 1 : 0)
    if (running) expect(fixture.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(fixture.agent.inbox.nextTurn.map(message => message.content)).toEqual([
      [{ type: 'text', text: 'queued' }],
    ])
    await fixture.ctx.fiber.dispose()
  })

  it('preserves non-text blocks and permits unchanged text', async () => {
    const fixture = await harness()
    fixture.session.append('turn/start', { turn: 1 })
    fixture.session.append('step/start', { turn: 1, step: 1 })
    const prompt = fixture.session.append('user/message', createUserMessage({
      content: [
        { type: 'image', attachment: { attachmentId: 'image' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
        { type: 'text', text: 'same' },
        { type: 'text', text: ' second block' },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    fixture.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'referenced context' }],
      source: {
        kind: 'session-reference',
        form: 'recall',
        version: 1,
        references: [],
      } as never,
    }), { surfaceOp: 'append' })
    fixture.session.append('step/end', { turn: 1, step: 1 })
    fixture.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await fixture.controller.edit(request(prompt.seq, prompt.seq, 'same second block'), new AbortController().signal)

    expect(fixture.sent[0]?.message.content).toEqual([
      { type: 'image', attachment: { attachmentId: 'image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
      { type: 'text', text: 'same second block' },
    ])
    expect(fixture.sent[0]?.followingMessages).toEqual([
      expect.objectContaining({ content: [{ type: 'text', text: 'referenced context' }] }),
    ])
    expect(fixture.session.deriveMessages().map(message => message.content)).toEqual([
      [
        { type: 'image', attachment: { attachmentId: 'image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
        { type: 'text', text: 'same second block' },
      ],
      [{ type: 'text', text: 'referenced context' }],
    ])
    await fixture.ctx.fiber.dispose()
  })

  it('rejects a preserved image before interrupting a text-only model', async () => {
    const fixture = await harness(true, ['text'])
    fixture.session.append('turn/start', { turn: 1 })
    fixture.session.append('step/start', { turn: 1, step: 1 })
    const prompt = fixture.session.append('user/message', createUserMessage({
      content: [
        { type: 'image', attachment: { attachmentId: 'image' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
        { type: 'text', text: 'describe' },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await expect(fixture.controller.edit(
      request(prompt.seq, prompt.seq, 'describe again'),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'session/attachment-invalid' })
    expect(fixture.cancel).not.toHaveBeenCalled()
    expect(fixture.sent).toEqual([])
    await fixture.ctx.fiber.dispose()
  })

  it('accepts a preserved image when the current model declares no modality list', async () => {
    const fixture = await harness(false, null)
    fixture.session.append('turn/start', { turn: 1 })
    fixture.session.append('step/start', { turn: 1, step: 1 })
    const prompt = fixture.session.append('user/message', createUserMessage({
      content: [
        { type: 'image', attachment: { attachmentId: 'image' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
        { type: 'text', text: 'describe' },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await expect(fixture.controller.edit(
      request(prompt.seq, prompt.seq, 'describe again'),
      new AbortController().signal,
    )).resolves.toMatchObject({ accepted: true })
    await fixture.ctx.fiber.dispose()
  })

  it('rejects invalid timezone and unavailable-model requests before interruption', async () => {
    const invalidZone = await harness(true)
    const zoneTarget = appendTurn(invalidZone.session, 1, 'prompt', 'answer')
    await expect(invalidZone.controller.edit({
      ...request(zoneTarget.seq, zoneTarget.seq),
      clientTimeZone: 'not/a-zone',
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'session/invalid-time-zone' })
    expect(invalidZone.cancel).not.toHaveBeenCalled()
    await invalidZone.ctx.fiber.dispose()

    const unavailable = await harness(true, ['text'], [])
    const modelTarget = appendTurn(unavailable.session, 1, 'prompt', 'answer')
    await expect(unavailable.controller.edit(
      request(modelTarget.seq, modelTarget.seq),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'session/model-unavailable' })
    expect(unavailable.cancel).not.toHaveBeenCalled()
    await unavailable.ctx.fiber.dispose()
  })

  it('honors cancellation before resolving the target Session', async () => {
    const fixture = await harness()
    const target = appendTurn(fixture.session, 1, 'prompt', 'answer')
    const controller = new AbortController()
    controller.abort(new Error('request stopped'))

    await expect(fixture.controller.edit(
      request(target.seq, target.seq),
      controller.signal,
    )).rejects.toThrow('request stopped')
    expect(fixture.sent).toEqual([])
    await fixture.ctx.fiber.dispose()
  })

  it('maps an admission race to stale and preserves an unexpected send failure as internal', async () => {
    const raced = await harness()
    const racedTarget = appendTurn(raced.session, 1, 'prompt', 'answer')
    vi.spyOn(raced.agent, 'runMaintenance').mockImplementation(async (operation) => {
      appendTurn(raced.session, 2, 'newer prompt', 'newer answer')
      return operation(new AbortController().signal)
    })
    await expect(raced.controller.edit(
      request(racedTarget.seq, racedTarget.seq),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'session/edit-stale' })
    await raced.ctx.fiber.dispose()

    const failedSend = await harness()
    const sendTarget = appendTurn(failedSend.session, 1, 'prompt', 'answer')
    const failure = new Error('send failed')
    vi.spyOn(failedSend.agent, 'send').mockImplementation(() => { throw failure })
    await expect(failedSend.controller.edit(
      request(sendTarget.seq, sendTarget.seq),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'gateway/internal', cause: failure })
    await failedSend.ctx.fiber.dispose()
  })

  it.each([new Error('cancel failed'), 'cancel failed'])('preserves a thrown cancellation (%s) as an internal failure', async (reason) => {
    const fixture = await harness(true)
    const target = appendTurn(fixture.session, 1, 'prompt', 'answer')
    vi.spyOn(fixture.agent, 'cancel').mockImplementation(() => { throw reason })

    await expect(fixture.controller.edit(
      request(target.seq, target.seq),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'gateway/internal' })
    await fixture.ctx.fiber.dispose()
  })

  it.each([false, true])('reports an occupied maintenance slot as busy (running=%s)', async (running) => {
    const fixture = await harness(running)
    const target = appendTurn(fixture.session, 1, 'prompt', 'answer')
    vi.spyOn(fixture.agent, 'runMaintenance').mockImplementation(() => { throw new Error('maintenance busy') })

    await expect(fixture.controller.edit(
      request(target.seq, target.seq),
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'session/agent-busy',
      details: { reason: 'Error: maintenance busy' },
    })
    await fixture.ctx.fiber.dispose()
  })

  it.each([new Error('request stopped'), 'request stopped'])('honors caller cancellation while waiting for idle (%s)', async (reason) => {
    const fixture = await harness(true)
    const target = appendTurn(fixture.session, 1, 'prompt', 'answer')
    const cancel = vi.spyOn(fixture.agent, 'cancel').mockImplementation(() => {})
    const controller = new AbortController()
    const editing = fixture.controller.edit(request(target.seq, target.seq), controller.signal)

    await vi.waitFor(() => { expect(cancel).toHaveBeenCalledOnce() })
    fixture.ctx.emit('agent/status', { agent: {} as Agent, status: 'idle' })
    fixture.ctx.emit('agent/status', { agent: fixture.agent, status: 'running' })
    controller.abort(reason)

    await expect(editing).rejects.toThrow(reason instanceof Error ? reason.message : 'edit request aborted')
    await fixture.ctx.fiber.dispose()
  })

  it('rejects when the edit message is discarded or its claimed turn closes before commit', async () => {
    const discarded = await harness()
    const discardedTarget = appendTurn(discarded.session, 1, 'prompt', 'answer')
    vi.spyOn(discarded.agent, 'send').mockImplementation((message) => {
      discarded.ctx.emit('agent/inbox/claimed', { agent: {} as Agent, message, turn: 8 })
      discarded.ctx.emit('agent/inbox/claimed', {
        agent: discarded.agent,
        message: createUserMessage({ content: [{ type: 'text', text: 'other' }], source: { kind: 'user' } }),
        turn: 8,
      })
      discarded.ctx.emit('agent/inbox/discarded', { agent: {} as Agent, message })
      discarded.ctx.emit('agent/inbox/discarded', { agent: discarded.agent, message })
    })
    await expect(discarded.controller.edit(
      request(discardedTarget.seq, discardedTarget.seq),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'session/edit-stale' })
    await discarded.ctx.fiber.dispose()

    const closed = await harness()
    const closedTarget = appendTurn(closed.session, 1, 'prompt', 'answer')
    const unrelatedSession = closed.ctx.sessions.create(SessionId('unrelated-edit-session'))
    vi.spyOn(closed.agent, 'send').mockImplementation((message) => {
      closed.ctx.emit('agent/inbox/claimed', { agent: closed.agent, message, turn: 9 })
      closed.ctx.emit('session/event', unrelatedSession, {
        type: 'turn/end', seq: SessionSeq(0), time: 0, data: { turn: 9, reason: { kind: 'blocked' } },
      })
      closed.session.append('turn/end', { turn: 9, reason: { kind: 'blocked' } })
    })
    await expect(closed.controller.edit(
      request(closedTarget.seq, closedTarget.seq),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'session/edit-stale' })
    await closed.ctx.fiber.dispose()
  })

  it('rejects when the Agent is disposed before the replacement commits', async () => {
    const fixture = await harness()
    const target = appendTurn(fixture.session, 1, 'prompt', 'answer')
    vi.spyOn(fixture.agent, 'send').mockImplementation(() => {
      fixture.ctx.emit('agent/disposed', { agent: {} as Agent })
      fixture.ctx.emit('agent/disposed', { agent: fixture.agent })
    })

    await expect(fixture.controller.edit(
      request(target.seq, target.seq),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'session/edit-stale' })
    await fixture.ctx.fiber.dispose()
  })

  it('allows the current replacement message to be edited again', async () => {
    const fixture = await harness()
    const original = appendTurn(fixture.session, 1, 'original', 'answer')
    const first = await fixture.controller.edit(
      request(original.seq, original.seq, 'first edit'),
      new AbortController().signal,
    )

    const second = await fixture.controller.edit(
      request(first.messageSeq, first.messageSeq, 'second edit'),
      new AbortController().signal,
    )

    expect(second.messageSeq).toBeGreaterThan(first.messageSeq)
    expect(fixture.session.deriveMessages().map(message => message.content)).toEqual([
      [{ type: 'text', text: 'second edit' }],
    ])
    await fixture.ctx.fiber.dispose()
  })

  it('retains a later compaction checkpoint positioned before the edited turn', async () => {
    const fixture = await harness()
    const first = appendTurn(fixture.session, 1, 'first', 'first answer')
    const second = appendTurn(fixture.session, 2, 'second', 'second answer')
    const firstAnswer = fixture.session.snapshotEvents().find(event =>
      event.type === 'assistant/message' && event.data.turn === 1)
    if (firstAnswer?.type !== 'assistant/message') throw new Error('missing first answer')
    const checkpoint = fixture.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }), {
      surfaceOp: { op: 'replace', start: first.seq, end: firstAnswer.seq },
      sourceEventSeqs: [first.seq, firstAnswer.seq],
    })

    await fixture.controller.edit(request(second.seq, second.seq), new AbortController().signal)

    expect(fixture.sent[0]?.intent?.surfaceOp).toMatchObject({
      op: 'replace',
      start: second.seq,
    })
    expect(fixture.session.surface.nodes[0]).toBe(checkpoint.seq)
    expect(fixture.session.deriveMessages().map(message => message.content)).toEqual([
      [{ type: 'text', text: 'summary' }],
      [{ type: 'text', text: 'edited' }],
    ])
    await fixture.ctx.fiber.dispose()
  })

  it('accepts legacy turns whose opening user message precedes step/start', async () => {
    const fixture = await harness()
    fixture.session.append('turn/start', { turn: 1 })
    const prompt = fixture.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'legacy prompt' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    fixture.session.append('step/start', { turn: 1, step: 1 })
    fixture.session.append('step/end', { turn: 1, step: 1 })
    fixture.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await expect(fixture.controller.edit(
      request(prompt.seq, prompt.seq, 'edited legacy prompt', undefined),
      new AbortController().signal,
    )).resolves.toMatchObject({ accepted: true })
    expect(fixture.sent[0]?.message.content).toEqual([{ type: 'text', text: 'edited legacy prompt' }])
    await fixture.ctx.fiber.dispose()
  })

  it('rejects stale, shadowed, steering, empty, and malformed requests before admission', async () => {
    const fixture = await harness()
    const first = appendTurn(fixture.session, 1, 'first', 'first answer')
    const second = appendTurn(fixture.session, 2, 'second', 'second answer')
    const expectCode = async (value: Promise<unknown>, code: string): Promise<void> => {
      await expect(value).rejects.toMatchObject({ code })
    }

    await expectCode(
      fixture.controller.edit(request(first.seq, first.seq), new AbortController().signal),
      'session/edit-stale',
    )
    await expectCode(
      fixture.controller.edit(request(first.seq, second.seq), new AbortController().signal),
      'session/edit-unavailable',
    )
    await expectCode(
      fixture.controller.edit(request(-1, second.seq), new AbortController().signal),
      'gateway/bad-request',
    )
    await expectCode(
      fixture.controller.edit(request(first.seq, -1), new AbortController().signal),
      'gateway/bad-request',
    )
    await expectCode(
      fixture.controller.edit(request(second.seq, second.seq, ''), new AbortController().signal),
      'gateway/bad-request',
    )

    const rewritten = fixture.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'replacement' }], source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', start: first.seq, end: SessionSeq(second.seq + 1) },
      sourceEventSeqs: [
        first.seq,
        SessionSeq(first.seq + 1),
        second.seq,
        SessionSeq(second.seq + 1),
      ],
      conversationOp: {
        op: 'replace',
        start: SessionSeq(first.seq - 2),
        end: SessionSeq(fixture.session.seq - 1),
      },
    })
    await expectCode(
      fixture.controller.edit(request(first.seq, rewritten.seq), new AbortController().signal),
      'session/edit-unavailable',
    )
    await fixture.ctx.fiber.dispose()
  })

  it('rejects the latest human message after compaction removes it from the current surface', async () => {
    const fixture = await harness()
    const target = appendTurn(fixture.session, 1, 'prompt', 'answer')
    const answer = fixture.session.snapshotEvents().find(event =>
      event.type === 'assistant/message' && event.data.turn === 1)
    if (answer?.type !== 'assistant/message') throw new Error('missing answer')
    fixture.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }), {
      surfaceOp: { op: 'replace', start: target.seq, end: answer.seq },
      sourceEventSeqs: [target.seq, answer.seq],
    })

    await expect(fixture.controller.edit(
      request(target.seq, target.seq),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'session/edit-unavailable' })
    await fixture.ctx.fiber.dispose()
  })

  it('rejects non-human, textless, turnless, steered, and step-less targets', async () => {
    const expectCode = async (value: Promise<unknown>): Promise<void> => {
      await expect(value).rejects.toMatchObject({ code: 'session/edit-unavailable' })
    }

    const nonHuman = await harness()
    nonHuman.session.append('turn/start', { turn: 1 })
    nonHuman.session.append('step/start', { turn: 1, step: 1 })
    const context = nonHuman.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'context' }], source: { kind: 'plugin', plugin: 'test' },
    }), { surfaceOp: 'append' })
    const human = nonHuman.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'human' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expectCode(nonHuman.controller.edit(request(context.seq, human.seq), new AbortController().signal))
    await nonHuman.ctx.fiber.dispose()

    const textless = await harness()
    textless.session.append('turn/start', { turn: 1 })
    textless.session.append('step/start', { turn: 1, step: 1 })
    const image = textless.session.append('user/message', createUserMessage({
      content: [{ type: 'image', attachment: { attachmentId: 'image' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expectCode(textless.controller.edit(request(image.seq, image.seq), new AbortController().signal))
    await textless.ctx.fiber.dispose()

    const turnless = await harness()
    const lone = turnless.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'lone' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expectCode(turnless.controller.edit(request(lone.seq, lone.seq), new AbortController().signal))
    await turnless.ctx.fiber.dispose()

    const stepLess = await harness()
    stepLess.session.append('turn/start', { turn: 1 })
    const noStep = stepLess.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'no step' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expectCode(stepLess.controller.edit(request(noStep.seq, noStep.seq), new AbortController().signal))
    await stepLess.ctx.fiber.dispose()

    const steered = await harness()
    const opening = appendTurn(steered.session, 1, 'opening', 'answer')
    steered.session.append('turn/start', { turn: 2 })
    steered.session.append('step/start', { turn: 2, step: 1 })
    const current = steered.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'current' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    steered.session.append('step/end', { turn: 2, step: 1 })
    steered.session.append('step/start', { turn: 2, step: 2 })
    const steering = steered.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'steering' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expectCode(steered.controller.edit(request(steering.seq, steering.seq), new AbortController().signal))
    expect(opening.seq).toBeLessThan(current.seq)
    await steered.ctx.fiber.dispose()
  })
})

describe('session.edit with AgentLoop', () => {
  it('runs the edited turn before preserved Queue work through the real loop', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    const adapter = new MockAdapter([
      textResponse('old answer'),
      textResponse('edited answer'),
      textResponse('queued answer'),
    ])
    ctx.llm.registerAdapter(['fixture'], adapter)
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      cwd: '/workspace',
    })
    const agent = await ctx.agentLoop.create(SessionId('real-edit'), {
      provider: 'fixture', model: 'fixture-model',
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'original' }], source: { kind: 'user' },
    }))
    await agent.whenIdle()
    const target = agent.session.snapshotEvents().find(event => event.type === 'user/message')
    if (target?.type !== 'user/message') throw new Error('missing original prompt')
    agent.inbox.append('next-turn', createUserMessage({
      content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' },
    }))

    const result = await remote.edit({
      requestId: 'real-edit-request' as SessionRequestId,
      sessionId: agent.id,
      messageSeq: target.seq,
      expectedLastUserSeq: target.seq,
      text: 'edited',
      clientTimeZone: 'UTC',
    })
    expect(result).toMatchObject({ ok: true, value: { accepted: true } })
    await agent.whenIdle()

    const requests = adapter.requests.map(request => JSON.stringify(request.messages))
    expect(requests).toHaveLength(3)
    expect(requests[1]).toContain('edited')
    expect(requests[1]).not.toContain('original')
    expect(requests[1]).not.toContain('queued')
    expect(requests[2]).toContain('queued')
    expect(agent.session.deriveMessages().map(message => message.content)).toEqual([
      [{ type: 'text', text: 'edited' }],
      [{ type: 'text', text: 'edited answer' }],
      [{ type: 'text', text: 'queued' }],
      [{ type: 'text', text: 'queued answer' }],
    ])
    await ctx.fiber.dispose()
  })

  it('interrupts a running turn before admitting the edited rerun', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    const adapter = new MockAdapter(['hang', textResponse('edited answer')])
    ctx.llm.registerAdapter(['fixture'], adapter)
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      cwd: '/workspace',
    })
    const agent = await ctx.agentLoop.create(SessionId('running-edit'), {
      provider: 'fixture', model: 'fixture-model',
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'original' }], source: { kind: 'user' },
    }))
    await vi.waitFor(() => {
      expect(adapter.requests).toHaveLength(1)
    })
    const target = agent.session.snapshotEvents().find(event => event.type === 'user/message')
    if (target?.type !== 'user/message') throw new Error('missing running prompt')

    const result = await remote.edit({
      requestId: 'running-edit-request' as SessionRequestId,
      sessionId: agent.id,
      messageSeq: target.seq,
      expectedLastUserSeq: target.seq,
      text: 'edited while running',
    })
    expect(result).toMatchObject({ ok: true })
    await agent.whenIdle()

    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event =>
      event.type === 'turn/end' ? event.data.reason.kind : '')).toEqual(['aborted', 'completed'])
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('edited while running')
    expect(JSON.stringify(adapter.requests[1]?.messages)).not.toContain('original')
    await ctx.fiber.dispose()
  })
})
