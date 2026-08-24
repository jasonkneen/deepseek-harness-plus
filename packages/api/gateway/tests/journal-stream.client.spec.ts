import { describe, expect, it, vi } from 'vitest'
import {
  RemoteJournalStream,
  RemoteStream,
  RemoteStreamCarrierError,
  type RemoteJournalChange,
  type RemoteJournalFrame,
  type RemoteStreamFactory,
  type RemoteStreamItem,
  type RemoteStreamOptions,
} from '../src/client/index.ts'

interface Entry {
  readonly seq: number
}

interface Page {
  readonly entries: readonly Entry[]
  readonly hasMore: boolean
  readonly marker: string
}

interface PageRequest {
  readonly before?: number
  readonly limit?: number
}

interface Generation {
  readonly frames: readonly (
    RemoteJournalFrame<Entry, number> | Promise<RemoteJournalFrame<Entry, number>>
  )[]
  readonly terminal?: Error
  readonly hold?: boolean
  readonly waitAfterFrames?: Promise<void>
  readonly afterFrame?: (index: number) => void
}

type PageSource = Page | Promise<Page> | ((signal: AbortSignal) => Promise<Page>)

const AVAILABLE_CONNECTION = {
  hostDescription: {
    getSnapshot: () => ({
      version: 'fixture', cwd: '/fixture', attachedSessions: 0, home: '/home/fixture', canOpenPath: true,
    }),
    subscribe: () => () => {},
  },
}

const entries = (...seqs: number[]): Entry[] => seqs.map(seq => ({ seq }))

const page = (marker: string, seqs: number[], hasMore = false): Page => ({
  entries: entries(...seqs),
  hasMore,
  marker,
})

const STREAM_FACTORY = {
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item> {
    return new RemoteStream(AVAILABLE_CONNECTION, options)
  },
}

class FixtureJournal extends RemoteJournalStream<Page, Entry, number, PageRequest> {
  constructor(
    private readonly generations: Generation[],
    private readonly pages: PageSource[],
    private readonly calls: string[],
    private readonly pageRequests: PageRequest[],
    private readonly pageCursors: number[],
    private readonly followCursors: (number | undefined)[],
    changes: RemoteJournalChange<Page, Entry>[],
    failed: (error: unknown) => void,
    factory: RemoteStreamFactory = STREAM_FACTORY,
  ) {
    super(factory, {
      name: 'fixture journal',
      emptyCursor: -1,
      entries: value => value.entries,
      hasMore: value => value.hasMore,
      cursor: entry => entry.seq,
      compare: (left, right) => left - right,
      follows: (left, right) => right === left + 1,
      publish: (change) => { changes.push(change) },
      failed,
    })
  }

  /** @inheritdoc */
  protected override async * follow(
    after: number | undefined,
    signal: AbortSignal,
  ): AsyncIterable<RemoteJournalFrame<Entry, number>> {
    this.calls.push('follow')
    this.followCursors.push(after)
    const generation = this.generations.shift()
    if (generation === undefined) throw new Error('no scripted journal generation')
    for (const [index, frame] of generation.frames.entries()) {
      yield await frame
      generation.afterFrame?.(index)
    }
    await generation.waitAfterFrames
    if (generation.terminal !== undefined) throw generation.terminal
    if (generation.hold === true && !signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
  }

  /** @inheritdoc */
  protected override readPage(
    request: PageRequest,
    through: number,
    signal: AbortSignal,
  ): Promise<Page> {
    this.calls.push('page')
    this.pageRequests.push(request)
    this.pageCursors.push(through)
    const value = this.pages.shift()
    if (value === undefined) throw new Error('no scripted journal page')
    return typeof value === 'function' ? value(signal) : Promise.resolve(value)
  }

  /** @inheritdoc */
  protected override repairRequest(request: PageRequest): PageRequest {
    return request.limit === undefined ? {} : { limit: request.limit }
  }
}

function journalFixture(
  generations: Generation[],
  pages: PageSource[],
  factory: RemoteStreamFactory = STREAM_FACTORY,
): {
  readonly journal: RemoteJournalStream<Page, Entry, number, PageRequest>
  readonly changes: RemoteJournalChange<Page, Entry>[]
  readonly failed: ReturnType<typeof vi.fn>
  readonly calls: string[]
  readonly pageRequests: PageRequest[]
  readonly pageCursors: number[]
  readonly followCursors: (number | undefined)[]
} {
  const calls: string[] = []
  const pageRequests: PageRequest[] = []
  const pageCursors: number[] = []
  const followCursors: (number | undefined)[] = []
  const changes: RemoteJournalChange<Page, Entry>[] = []
  const failed = vi.fn()
  const journal = new FixtureJournal(
    generations,
    pages,
    calls,
    pageRequests,
    pageCursors,
    followCursors,
    changes,
    failed,
    factory,
  )
  return { journal, changes, failed, calls, pageRequests, pageCursors, followCursors }
}

function remoteItem(
  generation: number,
  value: RemoteJournalFrame<Entry, number>,
  signal: AbortSignal,
): RemoteStreamItem<RemoteJournalFrame<Entry, number>> {
  return { generation, value, signal, accept: vi.fn() }
}

function controlledFactory(
  next: () => Promise<IteratorResult<RemoteStreamItem<RemoteJournalFrame<Entry, number>>>>,
): RemoteStreamFactory {
  const lifetime = new AbortController()
  return {
    $stream<Item>(): RemoteStream<Item> {
      const iterator = {
        next,
        return: async () => ({ done: true as const, value: undefined }),
      }
      return {
        signal: lifetime.signal,
        restart: () => {},
        dispose: async () => { lifetime.abort() },
        [Symbol.asyncIterator]: () => iterator,
      } as unknown as RemoteStream<Item>
    },
  }
}

describe('RemoteJournalStream', () => {
  it('opens follow before page, removes overlap, appends live entries, and prepends history', async () => {
    const fixture = journalFixture(
      [{
        frames: [
          { type: 'opened', cursor: 3 },
          { type: 'entry', entry: { seq: 3 } },
          { type: 'entry', entry: { seq: 4 } },
        ],
        hold: true,
      }],
      [page('tail', [2, 3], true), page('older', [0, 1])],
    )

    await fixture.journal.open({ limit: 2 })
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(2) })
    await fixture.journal.prepend({ before: 2, limit: 2 })

    expect(fixture.calls.slice(0, 2)).toEqual(['follow', 'page'])
    expect(fixture.pageRequests).toEqual([{ limit: 2 }, { before: 2, limit: 2 }])
    expect(fixture.pageCursors).toEqual([3, 4])
    expect(fixture.changes).toEqual([
      { type: 'replace', page: page('tail', [2, 3], true), entries: entries(2, 3), hasMore: true },
      { type: 'append', entry: { seq: 4 } },
      { type: 'prepend', page: page('older', [0, 1]), entries: entries(0, 1), hasMore: false },
    ])
    await fixture.journal.dispose()
    await fixture.journal.dispose()
  })

  it('exposes its shared cancellation signal', async () => {
    const fixture = journalFixture(
      [{ frames: [{ type: 'opened', cursor: -1 }], hold: true }],
      [page('empty', [])],
    )

    expect(fixture.journal.signal.aborted).toBe(false)
    await fixture.journal.open({})
    await fixture.journal.dispose()
    expect(fixture.journal.signal.aborted).toBe(true)
  })

  it('classifies normal endings before initial and resumed opening cursors', async () => {
    const initial = journalFixture([{ frames: [] }], [])
    await expect(initial.journal.open({})).rejects.toThrow(
      'fixture journal ended before its opening cursor',
    )

    const finish = Promise.withResolvers<undefined>()
    const resumed = journalFixture(
      [
        { frames: [{ type: 'opened', cursor: 0 }], waitAfterFrames: finish.promise },
        { frames: [] },
      ],
      [page('initial', [0])],
    )
    await resumed.journal.open({})
    finish.resolve(undefined)
    await vi.waitFor(() => { expect(resumed.failed).toHaveBeenCalledOnce() })
    expect(resumed.failed.mock.calls[0]?.[0]).toMatchObject({
      message: 'resumed fixture journal ended before its opening cursor',
    })
    await resumed.journal.dispose()
  })

  it('prepends into an empty window and accepts its first live entry', async () => {
    const empty = journalFixture(
      [{ frames: [{ type: 'opened', cursor: -1 }], hold: true }],
      [page('empty', []), page('older', [0]), page('oldest', [])],
    )
    await empty.journal.open({})
    await empty.journal.prepend({})
    expect(empty.changes.at(-1)).toEqual({
      type: 'prepend', page: page('older', [0]), entries: entries(0), hasMore: false,
    })
    await empty.journal.prepend({})
    expect(empty.changes.at(-1)).toEqual({
      type: 'prepend', page: page('oldest', []), entries: [], hasMore: false,
    })
    await empty.journal.dispose()

    const live = Promise.withResolvers<RemoteJournalFrame<Entry, number>>()
    const followed = journalFixture(
      [{ frames: [{ type: 'opened', cursor: -1 }, live.promise], hold: true }],
      [page('empty', [])],
    )
    await followed.journal.open({})
    live.resolve({ type: 'entry', entry: { seq: 0 } })
    await vi.waitFor(() => { expect(followed.changes).toHaveLength(2) })
    expect(followed.changes.at(-1)).toEqual({ type: 'append', entry: { seq: 0 } })
    await followed.journal.dispose()
  })

  it('publishes one sorted replacement from an exact page and live entries queued while it loads', async () => {
    let resolvePage!: (value: Page) => void
    const openingPage = new Promise<Page>((resolve) => { resolvePage = resolve })
    const fixture = journalFixture(
      [{
        frames: [
          { type: 'opened', cursor: 15 },
          { type: 'entry', entry: { seq: 17 } },
          { type: 'entry', entry: { seq: 16 } },
        ],
        hold: true,
      }],
      [openingPage],
    )

    const opening = fixture.journal.open({ limit: 6 })
    await vi.waitFor(() => {
      expect(fixture.calls.filter(call => call === 'page')).toHaveLength(1)
    })
    expect(fixture.changes).toEqual([])

    resolvePage(page('opening', [10, 11, 12, 13, 14, 15]))
    await opening

    expect(fixture.changes).toEqual([{
      type: 'replace',
      page: page('opening', [10, 11, 12, 13, 14, 15]),
      entries: entries(10, 11, 12, 13, 14, 15, 16, 17),
      hasMore: false,
    }])
    expect(fixture.pageCursors).toEqual([15])
    await fixture.journal.dispose()
  })

  it('repairs a replacement generation through one tail page and drops replay overlap', async () => {
    const lost = new RemoteStreamCarrierError('carrier lost')
    const fixture = journalFixture(
      [
        {
          frames: [
            { type: 'opened', cursor: 1 },
            { type: 'entry', entry: { seq: 2 } },
          ],
          terminal: lost,
        },
        {
          frames: [
            { type: 'opened', cursor: 4 },
            { type: 'entry', entry: { seq: 3 } },
            { type: 'entry', entry: { seq: 4 } },
          ],
          hold: true,
        },
      ],
      [page('initial', [0, 1]), page('repair', [0, 1, 2, 3, 4])],
    )

    await fixture.journal.open({ limit: 5 })
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(3) })

    expect(fixture.changes.map(change => change.type)).toEqual(['replace', 'append', 'replace'])
    expect(fixture.changes[2]).toMatchObject({
      type: 'replace', page: { marker: 'repair' }, entries: entries(0, 1, 2, 3, 4),
    })
    expect(fixture.followCursors).toEqual([undefined, 2])
    expect(fixture.pageCursors).toEqual([1, 4])
    expect(fixture.failed).not.toHaveBeenCalled()
    await fixture.journal.dispose()
  })

  it('restarts a page aborted with its carrier generation', async () => {
    const fixture = journalFixture(
      [
        {
          frames: [{ type: 'opened', cursor: 1 }],
          terminal: new RemoteStreamCarrierError('carrier lost during page'),
        },
        {
          frames: [{ type: 'opened', cursor: 2 }],
          hold: true,
        },
      ],
      [
        signal => new Promise<Page>((_resolve, reject) => {
          const aborted = (): void => { reject(new Error('page aborted')) }
          signal.addEventListener('abort', aborted, { once: true })
          if (signal.aborted) aborted()
        }),
        page('replacement', [0, 1, 2]),
      ],
    )

    await fixture.journal.open({ limit: 3 })

    expect(fixture.changes).toEqual([{
      type: 'replace',
      page: page('replacement', [0, 1, 2]),
      entries: entries(0, 1, 2),
      hasMore: false,
    }])
    expect(fixture.pageCursors).toEqual([1, 2])
    expect(fixture.followCursors).toEqual([undefined, 1])
    expect(fixture.failed).not.toHaveBeenCalled()
    await fixture.journal.dispose()
  })

  it('repairs a live gap before publishing another change', async () => {
    const fixture = journalFixture(
      [{
        frames: [
          { type: 'opened', cursor: 1 },
          { type: 'entry', entry: { seq: 4 } },
        ],
        hold: true,
      }],
      [page('initial', [0, 1]), page('repair', [0, 1, 2, 3, 4])],
    )

    await fixture.journal.open({})
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(2) })

    expect(fixture.changes.map(change => change.type)).toEqual(['replace', 'replace'])
    expect(fixture.changes[1]).toMatchObject({ page: { marker: 'repair' } })
    expect(fixture.pageCursors).toEqual([1, 4])
    await fixture.journal.dispose()
  })

  it('replaces a superseded live-gap repair with the next generation', async () => {
    const gap = Promise.withResolvers<RemoteJournalFrame<Entry, number>>()
    const fixture = journalFixture(
      [
        {
          frames: [{ type: 'opened', cursor: 1 }, gap.promise],
          terminal: new RemoteStreamCarrierError('generation lost'),
        },
        { frames: [{ type: 'opened', cursor: 4 }], hold: true },
      ],
      [
        page('initial', [0, 1]),
        () => new Promise<Page>(() => {}),
        page('replacement', [0, 1, 2, 3, 4]),
      ],
    )

    await fixture.journal.open({ limit: 5 })
    gap.resolve({ type: 'entry', entry: { seq: 4 } })
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(2) })
    expect(fixture.changes.at(-1)).toMatchObject({
      type: 'replace', page: { marker: 'replacement' }, entries: entries(0, 1, 2, 3, 4),
    })
    await fixture.journal.dispose()
  })

  it('replaces a superseded second repair page with the next generation', async () => {
    const live = Promise.withResolvers<RemoteJournalFrame<Entry, number>>()
    const liveConsumed = Promise.withResolvers<undefined>()
    const openingPage = Promise.withResolvers<Page>()
    const finish = Promise.withResolvers<undefined>()
    const fixture = journalFixture(
      [
        {
          frames: [{ type: 'opened', cursor: 1 }, live.promise],
          waitAfterFrames: finish.promise,
          terminal: new RemoteStreamCarrierError('generation lost'),
          afterFrame: (index) => { if (index === 1) liveConsumed.resolve(undefined) },
        },
        { frames: [{ type: 'opened', cursor: 4 }], hold: true },
      ],
      [
        openingPage.promise,
        () => new Promise<Page>(() => {}),
        page('replacement', [0, 1, 2, 3, 4]),
      ],
    )

    const opening = fixture.journal.open({})
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([1]) })
    live.resolve({ type: 'entry', entry: { seq: 3 } })
    await liveConsumed.promise
    openingPage.resolve(page('opening', [0, 1]))
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([1, 3]) })
    finish.resolve(undefined)
    await opening

    expect(fixture.pageCursors).toEqual([1, 3, 4])
    expect(fixture.changes).toEqual([{
      type: 'replace',
      page: page('replacement', [0, 1, 2, 3, 4]),
      entries: entries(0, 1, 2, 3, 4),
      hasMore: false,
    }])
    await fixture.journal.dispose()
  })

  it('rereads the tail when queued entries advance beyond the opening page', async () => {
    const live = Promise.withResolvers<RemoteJournalFrame<Entry, number>>()
    const liveConsumed = Promise.withResolvers<undefined>()
    const openingPage = Promise.withResolvers<Page>()
    const fixture = journalFixture(
      [{
        frames: [{ type: 'opened', cursor: 1 }, live.promise],
        hold: true,
        afterFrame: (index) => { if (index === 1) liveConsumed.resolve(undefined) },
      }],
      [openingPage.promise, page('repair', [0, 1, 2, 3])],
    )

    const opening = fixture.journal.open({ limit: 4 })
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([1]) })
    live.resolve({ type: 'entry', entry: { seq: 3 } })
    await liveConsumed.promise
    openingPage.resolve(page('opening', [0, 1]))
    await opening

    expect(fixture.pageCursors).toEqual([1, 3])
    expect(fixture.changes).toEqual([{
      type: 'replace', page: page('repair', [0, 1, 2, 3]), entries: entries(0, 1, 2, 3), hasMore: false,
    }])
    await fixture.journal.dispose()
  })

  it('rejects when queued entries advance beyond the second repair page', async () => {
    const firstLive = Promise.withResolvers<RemoteJournalFrame<Entry, number>>()
    const secondLive = Promise.withResolvers<RemoteJournalFrame<Entry, number>>()
    const firstConsumed = Promise.withResolvers<undefined>()
    const secondConsumed = Promise.withResolvers<undefined>()
    const openingPage = Promise.withResolvers<Page>()
    const repairPage = Promise.withResolvers<Page>()
    const fixture = journalFixture(
      [{
        frames: [{ type: 'opened', cursor: 1 }, firstLive.promise, secondLive.promise],
        hold: true,
        afterFrame: (index) => {
          if (index === 1) firstConsumed.resolve(undefined)
          if (index === 2) secondConsumed.resolve(undefined)
        },
      }],
      [openingPage.promise, repairPage.promise],
    )

    const opening = fixture.journal.open({})
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([1]) })
    firstLive.resolve({ type: 'entry', entry: { seq: 3 } })
    await firstConsumed.promise
    openingPage.resolve(page('opening', [0, 1]))
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([1, 3]) })
    secondLive.resolve({ type: 'entry', entry: { seq: 5 } })
    await secondConsumed.promise
    repairPage.resolve(page('repair', [0, 1, 2, 3]))

    await expect(opening).rejects.toThrow('page did not reach its opening cursor')
  })

  it('reports a resumed generation that emits an entry before its cursor', async () => {
    const finish = Promise.withResolvers<undefined>()
    const fixture = journalFixture(
      [
        {
          frames: [{ type: 'opened', cursor: 0 }],
          waitAfterFrames: finish.promise,
          terminal: new RemoteStreamCarrierError('lost'),
        },
        { frames: [{ type: 'entry', entry: { seq: 1 } }] },
      ],
      [page('initial', [0])],
    )

    await fixture.journal.open({})
    finish.resolve(undefined)
    await vi.waitFor(() => { expect(fixture.failed).toHaveBeenCalledOnce() })
    expect(fixture.failed.mock.calls[0]?.[0]).toMatchObject({
      message: 'resumed fixture journal emitted an entry before its opening cursor',
    })
    await fixture.journal.dispose()
  })

  it('reports a duplicate opening cursor after the initial page is published', async () => {
    const duplicate = Promise.withResolvers<RemoteJournalFrame<Entry, number>>()
    const fixture = journalFixture(
      [{ frames: [{ type: 'opened', cursor: 0 }, duplicate.promise], hold: true }],
      [page('initial', [0])],
    )

    await fixture.journal.open({})
    duplicate.resolve({ type: 'opened', cursor: 0 })
    await vi.waitFor(() => { expect(fixture.failed).toHaveBeenCalledOnce() })
    expect(fixture.failed.mock.calls[0]?.[0]).toMatchObject({
      message: 'fixture journal emitted more than one opening cursor',
    })
    await fixture.journal.dispose()
  })

  it('propagates follow failures and duplicate cursors while an opening page is pending', async () => {
    const pendingPage = new Promise<Page>(() => {})
    const failedFollow = journalFixture(
      [{ frames: [{ type: 'opened', cursor: 0 }], terminal: new Error('follow failed') }],
      [pendingPage],
    )
    await expect(failedFollow.journal.open({})).rejects.toThrow('follow failed')

    const duplicate = Promise.withResolvers<RemoteJournalFrame<Entry, number>>()
    const duplicatePage = new Promise<Page>(() => {})
    const duplicateOpening = journalFixture(
      [{ frames: [{ type: 'opened', cursor: 0 }, duplicate.promise] }],
      [duplicatePage],
    )
    const opening = duplicateOpening.journal.open({})
    await vi.waitFor(() => { expect(duplicateOpening.pageCursors).toEqual([0]) })
    duplicate.resolve({ type: 'opened', cursor: 0 })
    await expect(opening).rejects.toThrow('more than one opening cursor')
  })

  it('rejects an iterator that ends while its opening page is pending', async () => {
    const generation = new AbortController()
    const results = [
      Promise.resolve<IteratorResult<RemoteStreamItem<RemoteJournalFrame<Entry, number>>>>({
        done: false,
        value: remoteItem(1, { type: 'opened', cursor: 0 }, generation.signal),
      }),
      Promise.resolve<IteratorResult<RemoteStreamItem<RemoteJournalFrame<Entry, number>>>>({
        done: true,
        value: undefined,
      }),
    ]
    const fixture = journalFixture(
      [],
      [new Promise<Page>(() => {})],
      controlledFactory(() => results.shift() ?? Promise.resolve({ done: true, value: undefined })),
    )

    await expect(fixture.journal.open({})).rejects.toThrow(
      'ended while reading its replacement page',
    )
  })

  it('rejects an iterator that ends before its opening cursor', async () => {
    const factory = controlledFactory(() => Promise.resolve({ done: true, value: undefined }))
    const fixture = journalFixture([], [], factory)

    await expect(fixture.journal.open({})).rejects.toThrow(
      'ended before its opening cursor',
    )
  })

  it('suppresses a consumer failure after disposal begins', async () => {
    const generation = new AbortController()
    const next = Promise.withResolvers<IteratorResult<RemoteStreamItem<RemoteJournalFrame<Entry, number>>>>()
    const results = [
      Promise.resolve<IteratorResult<RemoteStreamItem<RemoteJournalFrame<Entry, number>>>>({
        done: false,
        value: remoteItem(1, { type: 'opened', cursor: 0 }, generation.signal),
      }),
      next.promise,
    ]
    const fixture = journalFixture(
      [],
      [page('initial', [0])],
      controlledFactory(() => results.shift() ?? Promise.resolve({ done: true, value: undefined })),
    )

    await fixture.journal.open({})
    const closing = fixture.journal.dispose()
    next.resolve({
      done: false,
      value: remoteItem(1, { type: 'opened', cursor: 0 }, generation.signal),
    })
    await closing
    expect(fixture.failed).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'ends', final: { done: true as const, value: undefined }, message: 'ended while replacing' },
    {
      name: 'emits another opening cursor',
      final: undefined,
      message: 'more than one opening cursor',
    },
  ])('rejects when an aborted page generation $name', async ({ final, message }) => {
    const generation = new AbortController()
    const pending = Promise.withResolvers<IteratorResult<RemoteStreamItem<RemoteJournalFrame<Entry, number>>>>()
    const nextPending = Promise.withResolvers<IteratorResult<RemoteStreamItem<RemoteJournalFrame<Entry, number>>>>()
    const results = [
      Promise.resolve<IteratorResult<RemoteStreamItem<RemoteJournalFrame<Entry, number>>>>({
        done: false,
        value: remoteItem(1, { type: 'opened', cursor: 0 }, generation.signal),
      }),
      pending.promise,
      nextPending.promise,
    ]
    const fixture = journalFixture(
      [],
      [signal => new Promise<Page>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('page aborted')) }, { once: true })
      })],
      controlledFactory(() => results.shift() ?? Promise.resolve({ done: true, value: undefined })),
    )

    const opening = fixture.journal.open({})
    await vi.waitFor(() => { expect(results).toHaveLength(1) })
    generation.abort()
    if (final === undefined) {
      pending.resolve({
        done: false,
        value: remoteItem(1, { type: 'entry', entry: { seq: 1 } }, generation.signal),
      })
      await vi.waitFor(() => { expect(results).toHaveLength(0) })
      nextPending.resolve({
        done: false,
        value: remoteItem(1, { type: 'opened', cursor: 1 }, generation.signal),
      })
    } else {
      pending.resolve(final)
    }
    await expect(opening).rejects.toThrow(message)
  })

  it('rejects malformed opening and page sequences', async () => {
    const beforeOpening = journalFixture(
      [{ frames: [{ type: 'entry', entry: { seq: 0 } }] }],
      [page('unused', [])],
    )
    await expect(beforeOpening.journal.open({})).rejects.toThrow('entry before its opening cursor')

    const discontinuousPage = journalFixture(
      [{ frames: [{ type: 'opened', cursor: 3 }], hold: true }],
      [page('bad', [0, 2, 3])],
    )
    await expect(discontinuousPage.journal.open({})).rejects.toThrow('page contains discontinuous entries')

    const shortPage = journalFixture(
      [{ frames: [{ type: 'opened', cursor: 3 }], hold: true }],
      [page('short', [0, 1])],
    )
    await expect(shortPage.journal.open({})).rejects.toThrow('page did not end at its requested cursor')

    const longPage = journalFixture(
      [{ frames: [{ type: 'opened', cursor: 1 }], hold: true }],
      [page('long', [0, 1, 2])],
    )
    await expect(longPage.journal.open({})).rejects.toThrow('page did not end at its requested cursor')
  })

  it('reports duplicate and regressed generation cursors as terminal failures', async () => {
    const duplicate = journalFixture(
      [{
        frames: [{ type: 'opened', cursor: 1 }, { type: 'opened', cursor: 1 }],
      }],
      [page('initial', [0, 1])],
    )
    await duplicate.journal.open({})
    await vi.waitFor(() => { expect(duplicate.failed).toHaveBeenCalledOnce() })
    const duplicateFailure: unknown = duplicate.failed.mock.calls[0]?.[0]
    expect(duplicateFailure).toBeInstanceOf(Error)
    if (!(duplicateFailure instanceof Error)) throw new Error('expected duplicate-cursor failure')
    expect(duplicateFailure.message).toContain('more than one opening cursor')

    const regressed = journalFixture(
      [
        {
          frames: [{ type: 'opened', cursor: 1 }, { type: 'entry', entry: { seq: 2 } }],
          terminal: new RemoteStreamCarrierError('lost'),
        },
        { frames: [{ type: 'opened', cursor: 1 }] },
      ],
      [page('initial', [0, 1])],
    )
    await regressed.journal.open({})
    await vi.waitFor(() => { expect(regressed.failed).toHaveBeenCalledOnce() })
    const regressedFailure: unknown = regressed.failed.mock.calls[0]?.[0]
    expect(regressedFailure).toBeInstanceOf(Error)
    if (!(regressedFailure instanceof Error)) throw new Error('expected regressed-cursor failure')
    expect(regressedFailure.message).toContain('behind the last applied entry')
  })

  it('rejects a discontinuous older page after publishing the fail-soft pagination state', async () => {
    const fixture = journalFixture(
      [{ frames: [{ type: 'opened', cursor: 4 }], hold: true }],
      [page('initial', [3, 4], true), page('older', [0, 1], true)],
    )
    await fixture.journal.open({})

    await expect(fixture.journal.prepend({ before: 3 })).rejects.toThrow('history page is discontinuous')
    expect(fixture.changes.at(-1)).toEqual({
      type: 'prepend', page: page('older', [0, 1], true), entries: [], hasMore: false,
    })
    await fixture.journal.dispose()
  })

  it('guards lifecycle operations before and after open', async () => {
    const fixture = journalFixture(
      [{ frames: [{ type: 'opened', cursor: -1 }], hold: true }],
      [page('empty', [])],
    )

    await expect(fixture.journal.prepend({})).rejects.toThrow('is not open')
    await fixture.journal.open({})
    await expect(fixture.journal.open({})).rejects.toThrow('already opened')
    fixture.journal.restart()
    await fixture.journal.dispose()
    await expect(fixture.journal.prepend({})).rejects.toThrow('is not open')
  })
})
