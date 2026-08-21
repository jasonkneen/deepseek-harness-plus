/** Low-level Win32 process, stdio, and Job Object primitives shared by sandbox and ordinary subprocess paths. */

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
  createKillOnCloseJob,
  drainPipe,
  isJobEmpty,
  openJobForAssignment,
  spawnInheritedJobProcess,
  spawnOrdinaryProcessInJob,
  spawnPipedProcess,
  terminateJob,
  waitForProcessExit,
} from './process.ts'
export type {
  OrdinaryProcessSpawnOptions,
  SpawnedAssignedProcess,
  SpawnedJobProcess,
  SpawnedPipedProcess,
} from './process.ts'
