/**
 * Check the page half of the tunnel against hand-fed frames: a stub worker replaces
 * the real one, so every reply shape — unary, streamed, refused, aborted — can be
 * delivered on demand and the client's reaction observed directly.
 *
 * The refusal warnings are the reason this suite exists. They are the only signal
 * that separates "the tunnel refused" from "the host tree answered with an error"
 * in an acceptance run's console log, and a diagnostic nothing exercises is a
 * diagnostic that silently stops working.
 *
 * The refusal text is matched verbatim on purpose: the worker composes it from the
 * expanded cause chain, so both sides hold each other to it. Do not relax these
 * expectations to make a change pass — agree the new text with the worker host first.
 */
import { expect, test } from 'vitest'
import { WorkerTunnel } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/client/client.ts'

// Both sides are serialized here, at call time, rather than inside the case: the
// blocks below reuse and clear the `warnings` array, so a captured reference
// would read a later block's state by the time the case executes.
const check = (label: string, actual: unknown, expected: unknown): void => {
  const [seen, wanted] = [JSON.stringify(actual), JSON.stringify(expected)]
  test(label, () => { expect(seen).toBe(wanted) })
}

const warnings: string[] = []
console.warn = (message: string) => { warnings.push(message) }
;(globalThis as { location?: unknown }).location = { origin: 'http://localhost:4173' }

type Listener = (event: { data: unknown }) => void

/** A worker stand-in: collects what the page sent, replays what the test delivers. */
function stubWorker(): { worker: Worker; sent: { t: string; id: number }[]; deliver: (frame: unknown) => void } {
  const listeners: Listener[] = []
  const sent: { t: string; id: number }[] = []
  const worker = {
    addEventListener: (type: string, listener: Listener) => { if (type === 'message') listeners.push(listener) },
    postMessage: (frame: unknown) => { sent.push(frame as { t: string; id: number }) },
  } as unknown as Worker
  return { worker, sent, deliver: (frame) => { for (const listener of listeners) listener({ data: frame }) } }
}

// A normal reply resolves and says nothing on the console.
{
  const { worker, sent, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const response = tunnel.fetch('/api/session.list', { method: 'POST', body: '{"a":1}' })
  const request = sent[0] as unknown as { t: string; id: number; method: string; url: string; body: ArrayBuffer }
  check('the request frame carries method and absolute url', [request.t, request.id, request.method, request.url],
    ['req', 1, 'POST', 'http://localhost:4173/api/session.list'])
  check('the request body travels as bytes', new TextDecoder().decode(request.body), '{"a":1}')
  deliver({ t: 'res', id: 1, status: 200, headers: {}, message: '{"ok":true}' })
  const resolved = await response
  check('a normal reply resolves', resolved.status, 200)
  check('a normal reply carries its body', await resolved.text(), '{"ok":true}')
  check('a normal reply warns about nothing', warnings.length, 0)
}

// A null-body status resolves without a body rather than throwing.
{
  const { worker, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const response = tunnel.fetch('/api/session.delete', { method: 'POST' })
  deliver({ t: 'res', id: 1, status: 204, headers: {} })
  check('204 resolves with a null body', (await response).body, null)
}

// A streamed reply reassembles in order and closes.
{
  const { worker, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const response = tunnel.fetch('/api/session.events', { method: 'POST' })
  deliver({ t: 'res-head', id: 1, status: 200, headers: { 'content-type': 'text/event-stream' } })
  const resolved = await response
  const encoder = new TextEncoder()
  deliver({ t: 'res-chunk', id: 1, chunk: encoder.encode('one ').buffer })
  deliver({ t: 'res-chunk', id: 1, chunk: encoder.encode('two').buffer })
  deliver({ t: 'res-end', id: 1 })
  check('a streamed reply reassembles in order', await resolved.text(), 'one two')
}

// A refusal names the request, so a console log alone tells tunnel from tree.
{
  warnings.length = 0
  const { worker, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const refused = tunnel.fetch('/api/session.create', { method: 'POST' })
  deliver({ t: 'res', id: 1, status: 503, headers: {}, message: 'host is not serving yet' })
  check('a 5xx reply still resolves', (await refused).status, 503)
  check('a 5xx reply is reported once', warnings, [
    'web-preview tunnel: request 1 POST http://localhost:4173/api/session.create → HTTP 503: host is not serving yet',
  ])
}

// An error frame rejects the caller and reports the same request.
{
  warnings.length = 0
  const { worker, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const errored = tunnel.fetch('/api/session.history', { method: 'POST' })
  deliver({ t: 'res-err', id: 1, message: 'boom: nested cause' })
  check('an error frame rejects', await errored.then(() => 'resolved', (error: unknown) => (error as Error).message),
    'web-preview tunnel: boom: nested cause')
  check('an error frame is reported once', warnings, [
    'web-preview tunnel: request 1 POST http://localhost:4173/api/session.history → res-err: boom: nested cause',
  ])
}

// A 4xx is the host tree answering, not the tunnel refusing: no warning.
{
  warnings.length = 0
  const { worker, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const denied = tunnel.fetch('/api/plugin.mount', { method: 'POST' })
  deliver({ t: 'res', id: 1, status: 403, headers: {}, message: 'privileged' })
  check('4xx resolves', (await denied).status, 403)
  check('4xx stays silent', warnings, [])
}

// Aborting sends an abort frame and rejects with AbortError.
{
  const { worker, sent, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const controller = new AbortController()
  const aborted = tunnel.fetch('/api/session.events', { method: 'POST', signal: controller.signal })
  controller.abort()
  check('abort rejects with AbortError', await aborted.then(() => 'resolved', (error: unknown) => (error as Error).name), 'AbortError')
  check('abort reaches the worker', sent.at(-1), { t: 'abort', id: 1 })
  // A late reply to an aborted request must not resurrect it.
  deliver({ t: 'res', id: 1, status: 200, headers: {}, message: 'late' })
}
