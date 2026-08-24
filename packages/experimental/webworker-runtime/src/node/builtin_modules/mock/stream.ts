/**
 * `node:stream` stub. Every harness import of this module in the reachable tree
 * is type-only (`Duplex`/`Readable`/`Writable` annotations), so nothing here runs
 * unless a value import appears; then it says so.
 */
import { notImplementedFail } from '../../notImplementedFail.ts'

const MODULE = 'node:stream'

/** Readable stream (unavailable; use WHATWG ReadableStream). */
export const Readable: typeof import('node:stream').Readable = notImplementedFail(MODULE, 'Readable')

/** Writable stream (unavailable). */
export const Writable: typeof import('node:stream').Writable = notImplementedFail(MODULE, 'Writable')

/** Duplex stream (unavailable). */
export const Duplex: typeof import('node:stream').Duplex = notImplementedFail(MODULE, 'Duplex')

/** Transform stream (unavailable). */
export const Transform: typeof import('node:stream').Transform = notImplementedFail(MODULE, 'Transform')

/** PassThrough stream (unavailable). */
export const PassThrough: typeof import('node:stream').PassThrough = notImplementedFail(MODULE, 'PassThrough')

/** Pipeline helper (unavailable). */
export const pipeline: typeof import('node:stream').pipeline = notImplementedFail(MODULE, 'pipeline')

/** Finished helper (unavailable). */
export const finished: typeof import('node:stream').finished = notImplementedFail(MODULE, 'finished')

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/** The `node:stream` declarations this module stands in for. */
type NodeFace = Partial<typeof import('node:stream')>

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default { Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished } satisfies NodeFace
