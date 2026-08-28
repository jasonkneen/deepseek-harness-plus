/** Shared low-level Win32 process, stdio, and Job Object primitives. */

export { ERROR_INSUFFICIENT_BUFFER } from './abi.ts'
export * from './errors.ts'
export {
  allocPtrSlot,
  allocUint32,
  decodePtr,
  decodeUint32,
  extendWin32ProcessBindings,
  isNullPtr,
  loadWin32ProcessBindings,
  throwLastError,
  throwWin32,
} from './ffi.ts'
export type {
  NativePtr,
  Win32ProcessBindings,
} from './ffi.ts'
export {
  closeHandleChecked,
  closeCurrentProcessStandardStreams,
  drainPipe,
  isJobEmpty,
  pollProcessExit,
  probeCurrentTokenJobSupport,
  spawnInheritedJobProcess,
  spawnCurrentTokenJobProcess,
  spawnPipedProcess,
  terminateJob,
  waitForProcessExit,
} from './process.ts'
export type {
  CurrentTokenProcessSpawnOptions,
  SpawnedJobProcess,
  SpawnedPipedProcess,
} from './process.ts'
