// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { HistoricalImageCache } from '../src/client/historical-images.ts'

describe('HistoricalImageCache', () => {
  it('invalidates a pending image load when its Session binding is released', async () => {
    const read = Promise.withResolvers<Awaited<ReturnType<SessionFace['readAttachment']>>>()
    const runtime = await SlotTestRuntime.create()
    const sessionId = await runtime.sessions.add({
      id: 's1',
      session: { readAttachment: () => read.promise },
    })
    const cache = new HistoricalImageCache(runtime.ctx)
    const attachment = {
      attachmentId: AttachmentId('image-1'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    } as const

    const pending = cache.resolve(sessionId, attachment)
    await runtime.sessions.remove(sessionId)
    read.resolve({ ok: true, value: { attachment, data: Uint8Array.of(1) } })

    await expect(pending).rejects.toThrow('ui-chat image scope was released before loading completed')
    await runtime.dispose()
  })
})
