/** Synthetic current-generation history and paced reply for browser measurements. */
import { createAssistantMessage, createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'

/** Closed turns in the browser history workload. */
export const HISTORY_TURNS = 240
/** Identity private to each isolated scaffold. */
export const SESSION_ID = 'benchmark-browser-history'
const TITLE = 'SYNTHETIC_BROWSER_HISTORY'
/** First streamed text marker. */
export const FIRST = 'SYNTHETIC_REPLY_FIRST'
/** Last streamed text marker. */
export const DONE = 'SYNTHETIC_REPLY_DONE'
/** Paced text chunks per continuation. */
export const DELTAS = 120
/** Replay delay per stream chunk, in milliseconds. */
export const PACE_MS = 8

/** Create mixed prose, code, reasoning and tool history without reading user data.
 * @returns Current Session JSONL accepted by the shared Web seeder.
 */
export function syntheticHistory(): string {
  const session = Session.create(SessionId(SESSION_ID))
  for (let turn = 1; turn <= HISTORY_TURNS; turn++) {
    session.append('turn/start', { turn })
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Review synthetic change ' + String(turn) + ': 检查增量渲染。 '.repeat(30) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    if (turn === 1) session.append('session/title', { title: TITLE, messageSeqs: [user.seq], source: { kind: 'fallback' } })
    session.append('step/start', { turn, step: 1 })
    const callId = ToolCallId('synthetic-tool-' + String(turn))
    const tool = turn % 6 === 0
    const code = turn % 12 === 0
      ? '\n\n```ts\n' + Array.from({ length: 60 }, (_, i) => 'const value' + String(i) + ' = ' + String(i)).join('\n') + '\n```'
      : ''
    session.append('assistant/message', {
      turn, step: 1, stream: [],
      message: createAssistantMessage({
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        content: [
          { type: 'reasoning', text: 'Compare the synthetic module and test. '.repeat(40) },
          { type: 'text', text: 'Synthetic answer ' + String(turn) + '. ' + 'Preserve ordering and validate the output. '.repeat(30) + code },
          ...tool ? [{ type: 'tool-call' as const, id: callId, name: 'synthetic_tool', arguments: '{"path":"src/example.ts"}' }] : [],
        ],
      }),
      usage: { inputTokens: 4000, outputTokens: 800 },
    }, { surfaceOp: 'append' })
    if (tool) {
      const call = session.append('tool/call', { turn, step: 1, callId, name: 'synthetic_tool', arguments: '{"path":"src/example.ts"}' })
      session.append('tool/result', { turn, step: 1, message: createToolResultMessage({
        callId, isError: false, content: [{ type: 'text', text: 'Synthetic tool output line.\n'.repeat(160) }],
      }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 1700000000000, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

/** Create one paced response; replay owns delays outside the browser.
 * @returns Stream chunks ending in a visible completion marker.
 */
export function syntheticReply(): StreamChunk[] {
  const deltas = Array.from({ length: DELTAS }, (_, i) => i === 0 ? FIRST + ' ' : i === DELTAS - 1 ? DONE : 'Synthetic response ' + String(i) + '. ')
  return [{ type: 'block-start', index: 0, blockType: 'text' }, ...deltas.map(text => ({ type: 'text-delta' as const, index: 0, text })), { type: 'block-end', index: 0, block: { type: 'text', text: deltas.join('') } }, { type: 'usage', usage: { inputTokens: 4000, outputTokens: 800 } }, { type: 'finish', reason: { kind: 'stop' } }]
}
