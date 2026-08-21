/** Low-level Win32 process, stdio, and Job Object primitives used by the Windows ACL sandbox. */

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
  drainPipe,
  isJobEmpty,
  pollProcessExit,
  spawnInheritedJobProcess,
  spawnOrdinaryJobProcess,
  spawnPipedProcess,
  terminateJob,
  waitForProcessExit,
} from './process.ts'
export type {
  OrdinaryProcessSpawnOptions,
  SpawnedJobProcess,
  SpawnedPipedProcess,
} from './process.ts'
