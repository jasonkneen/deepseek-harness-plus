/** Deterministic authentication failure for the search endpoint guidance snapshot. */
import { createServer } from 'node:http'

/** Fixed loopback port recorded in the provider diagnostic. */
const PORT = 43118

/** Cordis plugin name. */
export const name = 'web-search-error-fixture'

/** Start the local Messages endpoint and stop it with the plugin fiber. */
export async function apply(ctx) {
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/anthropic/v1/messages') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid snapshot API key' } }))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, '127.0.0.1', () => resolve(undefined))
  })
  server.unref()
  ctx.effect(() => async () => {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve(undefined))
      server.closeAllConnections()
    })
  }, 'web-search-error-fixture')
}
