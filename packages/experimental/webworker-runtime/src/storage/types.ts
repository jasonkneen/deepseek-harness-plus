/**
 * Filesystem interfaces shared by every VFS backend. The shipped implementation
 * is in memory; a browser-persistent backend would implement the same faces. Errors carry
 * Node's `code` values because roster plugins branch on them (`ENOENT` for
 * optional files, `EACCES` for read-only trees).
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/storage/types
 */

/** Encodings the VFS accepts where Node accepts any `BufferEncoding`. */
export type VfsEncoding = 'utf8' | 'utf-8'

/** Read options accepted by both the sync and promise faces. */
export type VfsReadOptions = VfsEncoding | { encoding?: VfsEncoding | null } | null | undefined

/** Node-compatible error with a `code`, as roster plugins expect. */
export interface VfsError extends Error {
  code: string
  path: string
  syscall: string
}

/** Subset of `fs.Stats` the roster reads. */
export interface VfsStats {
  readonly size: number
  readonly mtimeMs: number
  readonly mtime: Date
  readonly mode: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  isFIFO(): boolean
  isSocket(): boolean
  isBlockDevice(): boolean
  isCharacterDevice(): boolean
}

/**
 * Stats as Node returns them under `{ bigint: true }`.
 *
 * The filesystem service (`dsh-fs-local`) stats every target this way and then
 * does BigInt arithmetic on `mode` and builds its version token from
 * `dev:ino:size:mtimeNs:ctimeNs`, so these fields are load-bearing rather than
 * decorative: a number-valued `mode` here fails the whole read as a type error,
 * and a constant `ino`/`mtimeNs` would make the service's stale-write guard
 * unable to tell two revisions apart.
 */
export interface VfsBigIntStats {
  readonly size: bigint
  readonly mode: bigint
  /** One virtual device holds the whole image. */
  readonly dev: bigint
  /** Identity of the entry at this path; a removed and recreated path gets a new one. */
  readonly ino: bigint
  readonly nlink: bigint
  readonly mtimeMs: bigint
  readonly mtimeNs: bigint
  readonly ctimeMs: bigint
  readonly ctimeNs: bigint
  readonly atimeMs: bigint
  readonly atimeNs: bigint
  readonly birthtimeMs: bigint
  readonly birthtimeNs: bigint
  readonly mtime: Date
  readonly ctime: Date
  readonly atime: Date
  readonly birthtime: Date
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  isFIFO(): boolean
  isSocket(): boolean
  isBlockDevice(): boolean
  isCharacterDevice(): boolean
}

/** Stat option Node reads; `bigint` selects {@link VfsBigIntStats}. */
export interface VfsStatOptions {
  readonly bigint?: boolean
}

/** Write options the roster passes; `flag` decides create and truncate behavior. */
export interface VfsWriteOptions {
  readonly encoding?: VfsEncoding | null
  readonly mode?: number
  readonly flag?: string
}

/** Directory entry as `readdir` with `withFileTypes` reports it. */
export interface VfsDirent {
  readonly name: string
  readonly parentPath: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/** Directory handle returned by `opendir`; consumers only enumerate and close. */
export interface VfsDir {
  readonly path: string
  close(): Promise<void>
  read(): Promise<{ name: string } | null>
  [Symbol.asyncIterator](): AsyncGenerator<{ name: string; isFile(): boolean; isDirectory(): boolean }>
}

/** File handle returned by `open`; the roster writes, syncs, and closes. */
export interface VfsFileHandle {
  write(data: string | Uint8Array): Promise<{ bytesWritten: number }>
  writeFile(data: string | Uint8Array): Promise<void>
  readFile(options?: VfsReadOptions): Promise<string | Uint8Array>
  truncate(length?: number): Promise<void>
  stat(): Promise<VfsStats>
  sync(): Promise<void>
  datasync(): Promise<void>
  close(): Promise<void>
}
