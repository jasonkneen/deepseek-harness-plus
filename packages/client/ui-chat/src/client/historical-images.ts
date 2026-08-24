/** Session-scoped historical image URL cache owned by the Chat plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'

interface ImageUrlEntry {
  readonly sessionId: SessionId
  readonly generation: number
  readonly pending: Promise<string>
}

/** Resolve durable Chat images and release their browser URLs with Session scope. */
export class HistoricalImageCache {
  private readonly sessions: ISessions
  private readonly entries = new Map<string, ImageUrlEntry>()
  private readonly generations = new Map<SessionId, number>()
  private readonly scopeDisposers = new Map<SessionId, () => void>()
  private readonly urls = new Set<string>()
  private disposed = false

  /**
   * @param ctx - Owning ui-chat fiber.
   */
  constructor(ctx: Context) {
    this.sessions = ctx.sessions
    ctx.effect(() => () => { this.dispose() }, 'ui-chat historical image cache')
  }

  /**
   * Resolve and cache one session-authorized image URL.
   * @param sessionId - Session authorization and lifetime scope.
   * @param attachment - Durable image reference.
   * @returns browser URL valid until the Session binding is released.
   */
  resolve(sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('ui-chat image cache is disposed'))
    const key = `${sessionId}:${attachment.attachmentId}`
    const cached = this.entries.get(key)
    if (cached !== undefined) return cached.pending
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) {
      return Promise.reject(new Error(`ui-chat: unknown session "${sessionId}"`))
    }
    this.bindScope(sessionId, binding.ctx)
    const generation = this.generations.get(sessionId) ?? 0
    const pending = binding.session.readAttachment(attachment.attachmentId)
      .then((result) => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        if (this.disposed) throw new Error('ui-chat image cache was disposed before loading completed')
        if ((this.generations.get(sessionId) ?? 0) !== generation) {
          throw new Error('ui-chat image scope was released before loading completed')
        }
        if (typeof URL.createObjectURL !== 'function') {
          return `data:${result.value.attachment.mediaType};base64,${bytesToBase64(result.value.data)}`
        }
        const bytes = Uint8Array.from(result.value.data)
        const url = URL.createObjectURL(new Blob([bytes.buffer], { type: result.value.attachment.mediaType }))
        this.urls.add(url)
        return url
      })
      .catch((error: unknown) => {
        if (this.entries.get(key)?.generation === generation) this.entries.delete(key)
        throw error
      })
    this.entries.set(key, { sessionId, generation, pending })
    return pending
  }

  private bindScope(sessionId: SessionId, scope: Context): void {
    if (this.scopeDisposers.has(sessionId)) return
    const dispose = scope.effect(() => () => {
      this.scopeDisposers.delete(sessionId)
      this.release(sessionId)
    }, 'ui-chat historical image scope')
    this.scopeDisposers.set(sessionId, () => { void dispose() })
  }

  private release(sessionId: SessionId): void {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1)
    for (const [key, entry] of this.entries) {
      if (entry.sessionId !== sessionId) continue
      this.entries.delete(key)
      void entry.pending.then((url) => {
        if (!this.urls.delete(url)) return
        revokeUrl(url)
      }, () => {
        // Failed and invalidated loads create no browser URL.
      })
    }
  }

  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of [...this.scopeDisposers.values()]) dispose()
    this.scopeDisposers.clear()
    for (const url of this.urls) revokeUrl(url)
    this.urls.clear()
    this.entries.clear()
  }
}

function revokeUrl(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}
