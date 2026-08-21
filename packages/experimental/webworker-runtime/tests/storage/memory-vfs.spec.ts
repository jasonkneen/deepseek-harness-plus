/**
 * The identity, timestamp, and link guarantees MemoryVfs owes its consumers,
 * asserted on the filesystem directly rather than through the `node:fs` bridge.
 *
 * `dsh-fs-local` builds a version token from `dev:ino:size:mtimeNs:ctimeNs` and
 * refuses a write whose token moved since it read. Two properties carry that:
 * `ino` identifies the entry at a path, and `mtimeMs` moves on every write. The
 * timestamp cases freeze the clock, because these writes are in memory and two
 * revisions routinely land in the same millisecond — a real-clock test passes
 * whether or not the strict increment exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import type { VfsBigIntStats, VfsStats } from '../../src/storage/types.ts'

const identity = (vfs: MemoryVfs, path: string): bigint =>
  (vfs.statSync(path, { bigint: true }) as VfsBigIntStats).ino

const modified = (vfs: MemoryVfs, path: string): number => (vfs.statSync(path) as VfsStats).mtimeMs

afterEach(() => { vi.restoreAllMocks() })

describe('entry identity', () => {
  it('distinguishes paths and holds each identity across repeated stats', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/one.txt', 'one')
    vfs.seed('/dsh/two.txt', 'two')
    const first = identity(vfs, '/dsh/one.txt')
    expect(identity(vfs, '/dsh/two.txt')).not.toBe(first)
    expect(identity(vfs, '/dsh/one.txt')).toBe(first)
  })

  it('forgets the identities under a directory removed as a subtree', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/skills/git/SKILL.md', '# git\n')
    const before = identity(vfs, '/dsh/skills/git/SKILL.md')
    vfs.rmSync('/dsh/skills', { recursive: true })
    vfs.seed('/dsh/skills/git/SKILL.md', '# git rebuilt\n')
    expect(identity(vfs, '/dsh/skills/git/SKILL.md')).not.toBe(before)
  })

  it('assigns the destination of a rename an identity of its own', () => {
    // Identity belongs to the path, not to the bytes: a renamed-over path must
    // stop looking like the entry it replaced, which is the property the guard
    // reads. The source identity deliberately does not follow the move.
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/from.txt', 'moved')
    vfs.seed('/dsh/to.txt', 'replaced')
    const [source, destination] = [identity(vfs, '/dsh/from.txt'), identity(vfs, '/dsh/to.txt')]
    vfs.renameSync('/dsh/from.txt', '/dsh/to.txt')
    const renamed = identity(vfs, '/dsh/to.txt')
    expect(vfs.readFileSync('/dsh/to.txt', 'utf8')).toBe('moved')
    expect([renamed === source, renamed === destination]).toEqual([false, false])
  })
})

describe('modification time', () => {
  it('advances on every write even while the clock stands still', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/log.jsonl', 'first\n')
    const seeded = modified(vfs, '/dsh/log.jsonl')
    vfs.writeFileSync('/dsh/log.jsonl', 'second\n')
    const written = modified(vfs, '/dsh/log.jsonl')
    vfs.appendFileSync('/dsh/log.jsonl', 'third\n')
    const appended = modified(vfs, '/dsh/log.jsonl')
    vfs.truncateSync('/dsh/log.jsonl', 6)
    const truncated = modified(vfs, '/dsh/log.jsonl')
    expect([written > seeded, appended > written, truncated > appended]).toEqual([true, true, true])
    // One millisecond per revision: the increment is the minimum that separates
    // two tokens, not a coarser bump that would skew a real timestamp.
    expect(truncated - seeded).toBe(3)
  })

  it('takes the clock once the clock has passed the entry', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/log.jsonl', 'first\n')
    clock.mockReturnValue(1_700_000_005_000)
    vfs.writeFileSync('/dsh/log.jsonl', 'second\n')
    expect(modified(vfs, '/dsh/log.jsonl')).toBe(1_700_000_005_000)
  })
})

describe('hard links', () => {
  it('shares the bytes present at link time and diverges on the next write', () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/session.jsonl', 'committed\n')
    vfs.linkSync('/dsh/session.jsonl', '/dsh/session-latest.jsonl')
    expect(vfs.readFileSync('/dsh/session-latest.jsonl', 'utf8')).toBe('committed\n')
    vfs.appendFileSync('/dsh/session.jsonl', 'appended\n')
    expect(vfs.readFileSync('/dsh/session.jsonl', 'utf8')).toBe('committed\nappended\n')
    expect(vfs.readFileSync('/dsh/session-latest.jsonl', 'utf8')).toBe('committed\n')
  })
})
