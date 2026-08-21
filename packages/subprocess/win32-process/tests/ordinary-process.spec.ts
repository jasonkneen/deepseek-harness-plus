import koffi from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import {
  closeHandleChecked,
  createKillOnCloseJob,
  isJobEmpty,
  openJobForAssignment,
  spawnOrdinaryProcessInJob,
  terminateJob,
  Win32Error,
} from '../src/index.ts'
import {
  CREATE_SUSPENDED,
  JOB_OBJECT_ASSIGN_PROCESS,
  JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET,
  JOBOBJECT_BASIC_ACCOUNTING_SIZE,
  JobObjectBasicAccountingInformation,
} from '../src/abi.ts'
import { PROCESS_INFORMATION } from '../src/ffi.ts'
import type { NativePtr, Win32ProcessBindings } from '../src/index.ts'

function api(overrides: Partial<Win32ProcessBindings> = {}): Win32ProcessBindings {
  return {
    createJobObjectW: vi.fn(() => 50n),
    openJobObjectW: vi.fn(() => 55n),
    setInformationJobObject: vi.fn(() => 1),
    queryInformationJobObject: vi.fn((_job: NativePtr, _cls: number, information: Buffer) => {
      information.writeUInt32LE(0, JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET)
      return 1
    }),
    getStdHandle: vi.fn((selector: number) => BigInt(100 - selector)),
    setHandleInformation: vi.fn(() => 1),
    createProcessW: vi.fn((_app, _line, _pa, _ta, _inherit, _flags, _env, _cwd, _startup, info) => {
      koffi.encode(info, PROCESS_INFORMATION, {
        hProcess: 60n,
        hThread: 61n,
        dwProcessId: 1234,
        dwThreadId: 5678,
      })
      return 1
    }),
    assignProcessToJobObject: vi.fn(() => 1),
    resumeThread: vi.fn(() => 0),
    terminateProcess: vi.fn(() => 1),
    terminateJobObject: vi.fn(() => 1),
    waitForSingleObject: vi.fn(() => 0),
    getExitCodeProcess: vi.fn((_process, slot) => {
      koffi.encode(slot, 'uint32', 42)
      return 1
    }),
    closeHandle: vi.fn(() => 1),
    getLastError: vi.fn(() => 5),
    formatMessageW: vi.fn(() => 0),
    ...overrides,
  } as unknown as Win32ProcessBindings
}

describe('ordinary Job process operations', () => {
  it('creates suspended, assigns the Job, and resumes before returning', () => {
    const events: string[] = []
    const createJobObjectW = vi.fn(() => 50n as NativePtr)
    const createProcessW = vi.fn((
      _app: unknown,
      _line: unknown,
      _pa: unknown,
      _ta: unknown,
      _inherit: unknown,
      _flags: unknown,
      _env: unknown,
      _cwd: unknown,
      _startup: unknown,
      info: NativePtr,
    ) => {
      events.push('create')
      koffi.encode(info, PROCESS_INFORMATION, { hProcess: 60n, hThread: 61n, dwProcessId: 1234, dwThreadId: 5678 })
      return 1
    })
    const bindings = api({
      createJobObjectW,
      createProcessW,
      assignProcessToJobObject: vi.fn(() => { events.push('assign'); return 1 }),
      resumeThread: vi.fn(() => { events.push('resume'); return 0 }),
      closeHandle: vi.fn((handle: NativePtr) => { events.push(`close:${handle}`); return 1 }),
    })
    const job = createKillOnCloseJob(bindings, 'Local\\test-job')
    expect(spawnOrdinaryProcessInJob(bindings, {
      command: 'probe.exe',
      args: ['literal $VALUE', 'a b'],
      cwd: 'C:\\work',
    }, job)).toEqual({ pid: 1234, process: 60n })
    expect(createJobObjectW).toHaveBeenCalledWith(null, 'Local\\test-job')
    expect(createProcessW).toHaveBeenCalledWith(
      null,
      'probe.exe "literal $VALUE" "a b"',
      null,
      null,
      1,
      CREATE_SUSPENDED,
      null,
      'C:\\work',
      expect.anything(),
      expect.anything(),
    )
    expect(events.indexOf('create')).toBeLessThan(events.indexOf('assign'))
    expect(events.indexOf('assign')).toBeLessThan(events.indexOf('resume'))
    expect(events).toContain('close:61')
  })

  it('reports CreateProcessW failure without replaying another creator', () => {
    const bindings = api({ createProcessW: vi.fn(() => 0) })
    let caught: unknown
    try {
      spawnOrdinaryProcessInJob(bindings, { command: 'missing.exe', args: [], cwd: 'C:\\work' }, 50n as NativePtr)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ api: 'CreateProcessW', win32Code: 5 })
  })

  it('terminates an assigned suspended process when resume fails', () => {
    const terminateProcess = vi.fn(() => 1)
    const closeHandle = vi.fn(() => 1)
    const bindings = api({
      resumeThread: vi.fn(() => 0xFFFFFFFF),
      terminateProcess,
      closeHandle,
    })
    expect(() => spawnOrdinaryProcessInJob(bindings, {
      command: 'probe.exe',
      args: [],
      cwd: 'C:\\work',
    }, 50n as NativePtr)).toThrow(Win32Error)
    expect(terminateProcess).toHaveBeenCalledWith(60n, 1)
    expect(closeHandle).toHaveBeenCalledWith(61n)
    expect(closeHandle).toHaveBeenCalledWith(60n)
    expect(closeHandle).not.toHaveBeenCalledWith(50n)
  })

  it('reads Job emptiness without blocking', () => {
    const queryInformationJobObject = vi.fn((_job: NativePtr, _cls: number, information: Buffer) => {
      information.writeUInt32LE(1, JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET)
      return 1
    })
    const running = api({ queryInformationJobObject })
    expect(isJobEmpty(running, 50n as NativePtr)).toBe(false)
    expect(queryInformationJobObject).toHaveBeenCalledWith(
      50n,
      JobObjectBasicAccountingInformation,
      expect.objectContaining({ length: JOBOBJECT_BASIC_ACCOUNTING_SIZE }),
      JOBOBJECT_BASIC_ACCOUNTING_SIZE,
      null,
    )
    expect(isJobEmpty(api(), 50n as NativePtr)).toBe(true)
  })

  it('reports a Job accounting query failure', () => {
    const jobQuery = api({ queryInformationJobObject: vi.fn(() => 0) })
    expect(() => isJobEmpty(jobQuery, 50n as NativePtr)).toThrow(Win32Error)
  })

  it('checks Job termination and caller-owned handle closure', () => {
    const terminateJobObject = vi.fn(() => 1)
    const bindings = api({ terminateJobObject })
    expect(() => { terminateJob(bindings, 50n as NativePtr, 1) }).not.toThrow()
    expect(() => { closeHandleChecked(bindings, 50n as NativePtr, 'test Job') }).not.toThrow()
    expect(terminateJobObject).toHaveBeenCalledWith(50n, 1)

    const failing = api({ terminateJobObject: vi.fn(() => 0) })
    expect(() => { terminateJob(failing, 50n as NativePtr, 1) }).toThrow(Win32Error)

    const closeFailure = api({ closeHandle: vi.fn(() => 0) })
    expect(() => { closeHandleChecked(closeFailure, 50n as NativePtr, 'test Job') }).toThrow(Win32Error)
  })

  it('opens a named Job for process assignment', () => {
    const openJobObjectW = vi.fn(() => 55n as NativePtr)
    const bindings = api({ openJobObjectW })
    expect(openJobForAssignment(bindings, 'Local\\test-job')).toBe(55n)
    expect(openJobObjectW).toHaveBeenCalledWith(JOB_OBJECT_ASSIGN_PROCESS, 0, 'Local\\test-job')

    const missing = api({ openJobObjectW: vi.fn(() => 0n as NativePtr) })
    expect(() => openJobForAssignment(missing, 'Local\\missing-job')).toThrow(Win32Error)
  })
})
