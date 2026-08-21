/**
 * `node:fs` bridge over the worker's in-memory VFS. `MemoryVfs` owns paths,
 * bytes, the directory tree, and Node's error codes; this module adds only what
 * is Node-API-shaped and not VFS business: Buffer results, `Dirent` objects,
 * file descriptors, `mkdtemp`, access checks, inert watches, and the promise face.
 */
import { requireActiveVfs } from '../../../storage/active.ts'
import type { MemoryVfs } from '../../../storage/memory.ts'
import type { VfsBigIntStats, VfsStatOptions, VfsStats, VfsWriteOptions } from '../../../storage/types.ts'
import { Buffer } from 'buffer'
import { dirname } from './path.ts'

const vfs = (): MemoryVfs => requireActiveVfs()

const notImplemented = (method: string, subject: string): never => {
  throw new Error(`web-preview: node:fs.${method} is not implemented in the worker host (${subject})`)
}

type PathArg = string | URL | Uint8Array

const asPath = (path: PathArg): string => {
  if (typeof path === 'string') return path
  if (path instanceof URL) return decodeURIComponent(path.pathname)
  return new TextDecoder().decode(path)
}

type EncodingOption = BufferEncoding | { encoding?: BufferEncoding | null } | null | undefined

const encodingOf = (options: EncodingOption): BufferEncoding | undefined => {
  if (options === undefined || options === null) return undefined
  if (typeof options === 'string') return options
  return options.encoding ?? undefined
}

const bytesOf = (path: string): Uint8Array => vfs().readFileSync(path) as Uint8Array

/** Share the VFS bytes rather than copying them. */
const asBuffer = (bytes: Uint8Array): Buffer =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** Node `Dirent` subset returned by `readdirSync(dir, { withFileTypes: true })`. */
export class Dirent {
  /** Entry name, without its directory. */
  readonly name: string
  /** Directory this entry was listed from. */
  readonly parentPath: string
  private readonly file: boolean

  /**
   * Build one directory entry.
   * @param name - entry name.
   * @param parentPath - directory holding it.
   * @param file - whether the entry is a regular file.
   */
  constructor(name: string, parentPath: string, file: boolean) {
    this.name = name
    this.parentPath = parentPath
    this.file = file
  }

  /**
   * Entry kind, as `readdirSync` observed it.
   * @returns Whether the entry is a regular file.
   */
  isFile(): boolean {
    return this.file
  }

  /**
   * Entry kind, as `readdirSync` observed it.
   * @returns Whether the entry is a directory.
   */
  isDirectory(): boolean {
    return !this.file
  }

  /**
   * Symlink test, answered from the image's own shape.
   * @returns False — the image is materialized without symlinks.
   */
  isSymbolicLink(): boolean {
    return false
  }
}

/** Access-mode constants; the VFS has no permission model, so all bits pass. */
export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  COPYFILE_EXCL: 1,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_TRUNC: 512,
  O_APPEND: 1024,
}

/**
 * Read a file.
 * @param path - file path.
 * @param options - encoding, or an options object carrying one.
 * @returns bytes, or text when an encoding is given.
 */
export function readFileSync(path: PathArg, options?: EncodingOption): Buffer | string {
  const encoding = encodingOf(options)
  const bytes = bytesOf(asPath(path))
  return encoding === undefined || encoding === 'utf8' || encoding === 'utf-8'
    ? (encoding === undefined ? asBuffer(bytes) : new TextDecoder().decode(bytes))
    : asBuffer(bytes).toString(encoding)
}

/**
 * Write a file.
 * @param path - file path.
 * @param data - bytes or text.
 * @param options - write flag and creation mode, forwarded to the VFS.
 */
export function writeFileSync(path: PathArg, data: string | Uint8Array, options?: VfsWriteOptions): void {
  vfs().writeFileSync(asPath(path), data, options)
}

/**
 * Append to a file, creating it when absent.
 * @param path - file path.
 * @param data - bytes or text.
 */
export function appendFileSync(path: PathArg, data: string | Uint8Array): void {
  vfs().appendFileSync(asPath(path), data)
}

/**
 * Whether a path exists.
 * @param path - the path.
 * @returns true when present.
 */
export function existsSync(path: PathArg): boolean {
  return vfs().existsSync(asPath(path))
}

/**
 * Stat a path.
 * @param path - the path.
 * @param options - `bigint` selects the BigInt stats the filesystem service reads.
 * @returns the stats, in the plain or BigInt shape.
 */
export function statSync(path: PathArg, options?: VfsStatOptions): VfsStats | VfsBigIntStats {
  return vfs().statSync(asPath(path), options)
}

/**
 * Change an entry's permission bits; stat reads back exactly what was set.
 * @param path - the path.
 * @param mode - new permission bits (`0o777` mask), numeric or Node's octal string form.
 */
export function chmodSync(path: PathArg, mode: number | string): void {
  vfs().chmodSync(asPath(path), typeof mode === 'string' ? Number.parseInt(mode, 8) : mode)
}

/**
 * Stat a path without following symlinks (the image has none).
 * @param path - the path.
 * @param options - `bigint` selects the BigInt stats the filesystem service reads.
 * @returns the stats, in the plain or BigInt shape.
 */
export function lstatSync(path: PathArg, options?: VfsStatOptions): VfsStats | VfsBigIntStats {
  return statSync(path, options)
}

/**
 * Canonical path (normalization only: the image is symlink-free).
 * @param path - the path.
 * @returns the resolved path.
 */
export function realpathSync(path: PathArg): string {
  return vfs().realpathSync(asPath(path))
}

/**
 * List a directory.
 * @param path - directory path.
 * @param options - `withFileTypes` selects Dirent objects.
 * @returns names, or Dirent objects.
 */
export function readdirSync(
  path: PathArg,
  options?: { withFileTypes?: boolean } | BufferEncoding | null,
): string[] | Dirent[] {
  const target = asPath(path)
  const names = vfs().readdirSync(target)
  if (typeof options !== 'object' || options === null || options.withFileTypes !== true) return names
  return names.map(name => new Dirent(name, target, vfs().statSync(`${target}/${name}`).isFile()))
}

/**
 * Create a directory.
 * @param path - directory path.
 * @param options - `recursive` creates parents.
 * @returns the first created path when recursive, else undefined.
 */
export function mkdirSync(path: PathArg, options?: { recursive?: boolean; mode?: number }): string | undefined {
  return vfs().mkdirSync(asPath(path), options)
}

/**
 * Create a uniquely named directory.
 * @param prefix - path prefix; six random characters are appended.
 * @returns the created directory path.
 */
export function mkdtempSync(prefix: string): string {
  // Not crypto.randomUUID: browsers expose that only in secure contexts.
  const suffix = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(3)), byte => byte.toString(16).padStart(2, '0')).join('')
  const target = `${prefix}${suffix}`
  vfs().mkdirSync(target, { recursive: true })
  return target
}

/**
 * Remove a file or directory.
 * @param path - the path.
 * @param options - `recursive`/`force`, as in Node.
 */
export function rmSync(path: PathArg, options?: { recursive?: boolean; force?: boolean }): void {
  vfs().rmSync(asPath(path), options)
}

/**
 * Remove a file.
 * @param path - the path.
 */
export function unlinkSync(path: PathArg): void {
  vfs().rmSync(asPath(path))
}

/**
 * Rename a path.
 * @param from - source path.
 * @param to - target path.
 */
export function renameSync(from: PathArg, to: PathArg): void {
  vfs().renameSync(asPath(from), asPath(to))
}

/**
 * Access check: existence only.
 * @param path - the path.
 */
export function accessSync(path: PathArg): void {
  vfs().realpathSync(asPath(path))
}

interface OpenFile {
  path: string
  position: number
  append: boolean
}

const openFiles = new Map<number, OpenFile>()
let nextFd = 3

/**
 * Open a file descriptor.
 * @param path - file path.
 * @param flags - Node flag string: 'r', 'w', 'a', with optional '+' and the
 * exclusive 'x' (create-only) modifier.
 * @returns the descriptor.
 */
export function openSync(path: PathArg, flags = 'r'): number {
  const target = asPath(path)
  const exists = vfs().existsSync(target)
  if (flags.includes('x') && exists) {
    const error = new Error(`EEXIST: file already exists, open '${target}'`) as Error & { code: string; path: string }
    error.code = 'EEXIST'
    error.path = target
    throw error
  }
  if (flags.startsWith('r')) vfs().realpathSync(target)
  else if (flags.startsWith('w') || !exists) vfs().writeFileSync(target, new Uint8Array(0))
  const fd = nextFd++
  openFiles.set(fd, { path: target, position: 0, append: flags.startsWith('a') })
  return fd
}

const fileOf = (fd: number, syscall: string): OpenFile => {
  const file = openFiles.get(fd)
  if (file === undefined) throw new Error(`EBADF: bad file descriptor, ${syscall}`)
  return file
}

/**
 * Read from a descriptor.
 * @param fd - descriptor.
 * @param buffer - destination.
 * @param offset - destination offset.
 * @param length - byte count.
 * @param position - file position, or null to continue from the cursor.
 * @returns bytes read.
 */
export function readSync(
  fd: number,
  buffer: Uint8Array,
  offset = 0,
  length = buffer.byteLength,
  position: number | null = null,
): number {
  const file = fileOf(fd, 'read')
  const bytes = bytesOf(file.path)
  const from = position ?? file.position
  const slice = bytes.subarray(from, from + length)
  buffer.set(slice, offset)
  if (position === null) file.position = from + slice.byteLength
  return slice.byteLength
}

/**
 * Write through a descriptor.
 * @param fd - descriptor.
 * @param data - bytes or text.
 * @returns bytes written.
 */
export function writeSync(fd: number, data: string | Uint8Array): number {
  const file = fileOf(fd, 'write')
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  if (file.append) {
    vfs().appendFileSync(file.path, bytes)
    return bytes.byteLength
  }
  const existing = vfs().existsSync(file.path) ? bytesOf(file.path) : new Uint8Array(0)
  const merged = new Uint8Array(Math.max(existing.byteLength, file.position + bytes.byteLength))
  merged.set(existing, 0)
  merged.set(bytes, file.position)
  vfs().writeFileSync(file.path, merged)
  file.position += bytes.byteLength
  return bytes.byteLength
}

/**
 * Close a descriptor.
 * @param fd - descriptor.
 */
export function closeSync(fd: number): void {
  openFiles.delete(fd)
}

/**
 * Create a second name for one file's contents. Hard links do not exist in the
 * VFS, so the bytes are copied.
 * @param from - existing path.
 * @param to - new path.
 */
export function linkSync(from: PathArg, to: PathArg): void {
  writeFileSync(to, bytesOf(asPath(from)))
}

/**
 * Open file handle (`fs.FileHandle` subset): the atomic-write and durability
 * pair the storage backends use. `sync`/`datasync` are no-ops — an in-memory
 * filesystem has nothing to flush, and a worker reload loses it either way.
 */
export interface FileHandle {
  readonly fd: number
  readFile(options?: EncodingOption): Promise<Buffer | string>
  writeFile(data: string | Uint8Array, encoding?: BufferEncoding): Promise<void>
  write(data: string | Uint8Array): Promise<{ bytesWritten: number }>
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number; buffer: Uint8Array }>
  stat(): Promise<VfsStats>
  truncate(length?: number): Promise<void>
  sync(): Promise<void>
  datasync(): Promise<void>
  close(): Promise<void>
}

/**
 * Open a file handle. Directories open read-only, which is what the durability
 * helpers do before an fsync.
 * @param path - file or directory path.
 * @param flags - Node flag string.
 * @returns the handle.
 */
export function openHandleSync(path: PathArg, flags = 'r'): FileHandle {
  const target = asPath(path)
  const directory = vfs().existsSync(target) && vfs().statSync(target).isDirectory()
  const append = flags.startsWith('a')
  const fd = directory ? -1 : openSync(target, flags)
  return {
    fd,
    readFile: async (options?: EncodingOption) => readFileSync(target, options),
    // Node appends when the handle was opened with 'a'. The JSONL session log
    // depends on it — `open(path, 'a')` then `writeFile(batch)` — and replacing
    // the file there destroys the header frame its reader requires.
    writeFile: async (data: string | Uint8Array) => {
      if (append) appendFileSync(target, data)
      else writeFileSync(target, data)
    },
    write: async (data: string | Uint8Array) => ({ bytesWritten: writeSync(fd, data) }),
    read: async (buffer: Uint8Array, offset = 0, length = buffer.byteLength, position: number | null = null) => ({
      bytesRead: readSync(fd, buffer, offset, length, position),
      buffer,
    }),
    stat: async () => statSync(target) as VfsStats,
    truncate: async (length = 0) => {
      writeFileSync(target, bytesOf(target).subarray(0, length))
    },
    sync: async () => { /* memory-backed: nothing to flush */ },
    datasync: async () => { /* memory-backed: nothing to flush */ },
    close: async () => {
      if (fd !== -1) closeSync(fd)
    },
  }
}

/**
 * Watch registration refuses loudly, and NOT because watching is hard.
 *
 * The inert form was tried: `chokidar.ts` records that "no events" is the truth
 * about a filesystem with no external writer, and the same reasoning seemed to
 * cover this. It does not, because of the caller. `skill-filesystem` does not
 * merely register a listener — `openStableWatcher` opens a watcher and then
 * loops until two consecutive mode probes agree, so a watcher that reports
 * success and never fires leaves `observeRoots()` awaiting forever: the skill
 * catalog RPC never answers and the worker's single thread stops serving `/api`
 * for the rest of the session. A refusal instead fails that path fast, which the
 * provider already handles by returning an incomplete observation.
 *
 * So the family split is about what the CALLER does with the capability, not
 * about the capability: a listener registration tolerates absence, a watcher
 * whose progress is awaited does not.
 * @param path - the path a caller wanted watched, named in the refusal.
 * @returns Never — it throws naming the unavailable member.
 */
export function watchFile(path: PathArg): never {
  return notImplemented('watchFile', asPath(path))
}

/** Watch removal; teardown paths call it unconditionally, and nothing was watched. */
export function unwatchFile(): void {
  // No watch was ever established.
}

/**
 * Streaming read is unavailable: node:stream has no implementation here.
 * @param path - the path a caller wanted streamed, named in the refusal.
 * @returns Never — it throws naming the unavailable member.
 */
export function createReadStream(path: PathArg): never {
  return notImplemented('createReadStream', asPath(path))
}

/**
 * Streaming write counterpart of {@link createReadStream}.
 * @param path - the path a caller wanted streamed, named in the refusal.
 * @returns Never — it throws naming the unavailable member.
 */
export function createWriteStream(path: PathArg): never {
  return notImplemented('createWriteStream', asPath(path))
}

/** Open directory handle (`fs.Dir` subset): iteration plus the close pair. */
export interface Dir {
  readonly path: string
  read(): Promise<Dirent | null>
  close(): Promise<void>
  closeSync(): void
  [Symbol.asyncIterator](): AsyncIterableIterator<Dirent>
}

/**
 * Open a directory handle. Callers use it to assert "this path is a directory"
 * and to walk entries; the listing is taken once, since the VFS has no external
 * writer to race with.
 * @param path - directory path.
 * @returns the handle.
 */
export function opendirSync(path: PathArg): Dir {
  const target = asPath(path)
  const entries = readdirSync(target, { withFileTypes: true }) as Dirent[]
  let index = 0
  const next = (): Dirent | null => entries[index++] ?? null
  return {
    path: target,
    read: async () => next(),
    close: async () => { index = entries.length },
    closeSync: () => { index = entries.length },
    async *[Symbol.asyncIterator]() {
      for (let entry = next(); entry !== null; entry = next()) yield entry
    },
  }
}

/**
 * Promise face (`node:fs/promises`) over the same VFS. Each member answers the
 * union the VFS produces rather than Node's encoding-dependent overloads, so the
 * check here is that every name is a real `node:fs/promises` export.
 */
export const promises = {
  readFile: async (path: PathArg, options?: EncodingOption): Promise<Buffer | string> => readFileSync(path, options),
  writeFile: async (
    path: PathArg,
    data: string | Uint8Array,
    options?: { flag?: string; mode?: number } | BufferEncoding | null,
  ): Promise<void> => {
    const flag = typeof options === 'object' && options !== null ? options.flag : undefined
    const mode = typeof options === 'object' && options !== null ? options.mode : undefined
    if (flag !== undefined && flag.includes('x') && existsSync(path)) {
      const error = new Error(`EEXIST: file already exists, open '${asPath(path)}'`) as Error & { code: string }
      error.code = 'EEXIST'
      throw error
    }
    if (flag !== undefined && flag.startsWith('a')) appendFileSync(path, data)
    else writeFileSync(path, data, { ...flag === undefined ? {} : { flag }, ...mode === undefined ? {} : { mode } })
  },
  appendFile: async (path: PathArg, data: string | Uint8Array): Promise<void> => { appendFileSync(path, data) },
  mkdir: async (path: PathArg, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined> => mkdirSync(path, options),
  mkdtemp: async (prefix: string): Promise<string> => mkdtempSync(prefix),
  readdir: async (
    path: PathArg,
    options?: { withFileTypes?: boolean } | BufferEncoding,
  ): Promise<string[] | Dirent[]> => readdirSync(path, options),
  stat: async (path: PathArg, options?: VfsStatOptions): Promise<VfsStats | VfsBigIntStats> => statSync(path, options),
  lstat: async (path: PathArg, options?: VfsStatOptions): Promise<VfsStats | VfsBigIntStats> => lstatSync(path, options),
  realpath: async (path: PathArg): Promise<string> => realpathSync(path),
  rm: async (path: PathArg, options?: { recursive?: boolean; force?: boolean }): Promise<void> => { rmSync(path, options) },
  unlink: async (path: PathArg): Promise<void> => { unlinkSync(path) },
  rename: async (from: PathArg, to: PathArg): Promise<void> => { renameSync(from, to) },
  access: async (path: PathArg): Promise<void> => { accessSync(path) },
  chmod: async (path: PathArg, mode: number | string): Promise<void> => { chmodSync(path, mode) },
  cp: async (from: PathArg, to: PathArg): Promise<void> => {
    const source = asPath(from)
    const target = asPath(to)
    if (statSync(source).isDirectory()) {
      mkdirSync(target, { recursive: true })
      for (const name of vfs().readdirSync(source)) await promises.cp(`${source}/${name}`, `${target}/${name}`)
      return
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytesOf(source))
  },
  // The VFS has no inodes, so a hard link is a byte copy: the caller's contract
  // is only that both names read the same content until one is removed.
  link: async (from: PathArg, to: PathArg): Promise<void> => { linkSync(from, to) },
  open: async (path: PathArg, flags?: string): Promise<FileHandle> => openHandleSync(path, flags),
  opendir: async (path: PathArg): Promise<Dir> => opendirSync(path),
  truncate: async (path: PathArg, length = 0): Promise<void> => {
    writeFileSync(path, bytesOf(asPath(path)).subarray(0, length))
  },
  constants,
} satisfies Partial<Record<keyof typeof import('node:fs/promises'), unknown>>

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/**
 * Members Node declares as encoding- and option-dependent overload ladders
 * (`readFileSync` answering `Buffer` XOR `string`, `statSync` answering `Stats`
 * XOR `BigIntStats`, `mkdirSync` answering `string` XOR `void`). This module
 * answers the union its VFS actually produces from one signature, which no single
 * signature can present as all of Node's overloads; `realpathSync` additionally
 * carries Node's `.native` member, and `constants`, `promises`, and `Dirent` hold
 * the subsets the host tree reads.
 */
type OwnSignature =
  | 'constants' | 'promises' | 'Dirent'
  | 'readFileSync' | 'writeFileSync' | 'appendFileSync' | 'statSync' | 'lstatSync' | 'realpathSync'
  | 'readdirSync' | 'mkdirSync' | 'mkdtempSync' | 'rmSync' | 'opendirSync'
  | 'openSync' | 'readSync' | 'writeSync'

/**
 * The `node:fs` declarations this module stands in for. Every other member is
 * checked against Node; `openHandleSync` is the worker's own handle opener, which
 * `promises.open` answers with and Node has no synchronous counterpart for.
 */
type NodeFace = Partial<Omit<typeof import('node:fs'), OwnSignature>>
  & Record<OwnSignature | 'openHandleSync', unknown>

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  constants, promises, Dirent,
  readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync, realpathSync, chmodSync,
  readdirSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, renameSync, accessSync, opendirSync,
  openHandleSync, linkSync,
  openSync, readSync, writeSync, closeSync, watchFile, unwatchFile,
  createReadStream, createWriteStream,
} satisfies NodeFace
