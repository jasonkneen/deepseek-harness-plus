import koffi from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import {
  closeHandleChecked,
  isJobEmpty,
  pollProcessExit,
  probeCurrentTokenJobSupport,
  spawnCurrentTokenJobProcess,
  terminateJob,
  Win32Error,
} from '../src/index.ts'
import {
  CREATE_SUSPENDED,
  JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET,
  JOBOBJECT_BASIC_ACCOUNTING_SIZE,
  JobObjectBasicAccountingInformation,
  WAIT_TIMEOUT,
} from '../src/abi.ts'
import { PROCESS_INFORMATION, STARTUPINFOW } from '../src/ffi.ts'
import type {
  CurrentTokenProcessBindings,
  NativePtr,
} from '../src/index.ts'

function api(overrides: Partial<CurrentTokenProcessBindings> = {}): CurrentTokenProcessBindings {
  return {
    createJobObjectW: vi.fn(() => 50n),
    setInformationJobObject: vi.fn(() => 1),
    queryInformationJobObject: vi.fn((_job: NativePtr, _cls: number, information: Buffer) => {
      information.writeUInt32LE(0, JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET)
      return 1
    }),
    getStdHandle: vi.fn((selector: number) => BigInt(100 - selector)),
    getOsfHandle: vi.fn((fileDescriptor: number) => BigInt(67 + fileDescriptor)),
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
  } as unknown as CurrentTokenProcessBindings
}

describe('ordinary Job process operations', () => {
  it('creates suspended, assigns the Job, and resumes before returning', () => {
    const events: string[] = []
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
      createProcessW,
      assignProcessToJobObject: vi.fn(() => { events.push('assign'); return 1 }),
      resumeThread: vi.fn(() => { events.push('resume'); return 0 }),
      closeHandle: vi.fn((handle: NativePtr) => { events.push(`close:${handle}`); return 1 }),
    })
    expect(spawnCurrentTokenJobProcess(bindings, {
      command: 'probe.exe',
      applicationName: 'C:\\resolved\\probe.exe',
      args: ['literal $VALUE', 'a b'],
      cwd: 'C:\\work',
      stdio: { stdin: 4, stdout: 5, stderr: 6 },
    })).toEqual({ pid: 1234, process: 60n, job: 50n })
    expect(createProcessW).toHaveBeenCalledWith(
      'C:\\resolved\\probe.exe',
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
      spawnCurrentTokenJobProcess(bindings, {
        command: 'missing.exe',
        args: [],
        cwd: 'C:\\work',
        stdio: { stdin: 4, stdout: 5, stderr: 6 },
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ api: 'CreateProcessW', win32Code: 5 })
  })

  it('resolves the target carrier descriptors and restores their handle flags', () => {
    let startup: Record<string, unknown> | undefined
    const getOsfHandle = vi.fn((fileDescriptor: number) => BigInt(67 + fileDescriptor))
    const setHandleInformation = vi.fn(() => 1)
    const bindings = api({
      getOsfHandle,
      setHandleInformation,
      createProcessW: vi.fn((_app, _line, _pa, _ta, _inherit, _flags, _env, _cwd, infoPtr, processInfo) => {
        startup = koffi.decode(infoPtr, STARTUPINFOW) as Record<string, unknown>
        koffi.encode(processInfo, PROCESS_INFORMATION, {
          hProcess: 60n,
          hThread: 61n,
          dwProcessId: 1234,
          dwThreadId: 5678,
        })
        return 1
      }),
    })
    expect(spawnCurrentTokenJobProcess(bindings, {
      command: 'probe.exe',
      args: [],
      cwd: 'C:\\work',
      stdio: { stdin: 4, stdout: 5, stderr: 6 },
    })).toEqual({ pid: 1234, process: 60n, job: 50n })
    expect(getOsfHandle.mock.calls.map(([fileDescriptor]) => fileDescriptor)).toEqual([4, 5, 6])
    expect(startup).toMatchObject({ hStdInput: 71n, hStdOutput: 72n, hStdError: 73n })
    expect(setHandleInformation.mock.calls).toEqual([
      [71n, 1, 1], [72n, 1, 1], [73n, 1, 1],
      [71n, 1, 0], [72n, 1, 0], [73n, 1, 0],
    ])
  })

  it('polls direct exit and Job emptiness without blocking', () => {
    const queryInformationJobObject = vi.fn((_job: NativePtr, _cls: number, information: Buffer) => {
      information.writeUInt32LE(1, JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET)
      return 1
    })
    const running = api({
      waitForSingleObject: vi.fn(() => WAIT_TIMEOUT),
      queryInformationJobObject,
    })
    expect(pollProcessExit(running, 60n as NativePtr)).toBeUndefined()
    expect(isJobEmpty(running, 50n as NativePtr)).toBe(false)
    expect(queryInformationJobObject).toHaveBeenCalledWith(
      50n,
      JobObjectBasicAccountingInformation,
      expect.objectContaining({ length: JOBOBJECT_BASIC_ACCOUNTING_SIZE }),
      JOBOBJECT_BASIC_ACCOUNTING_SIZE,
      null,
    )

    const exited = api()
    expect(pollProcessExit(exited, 60n as NativePtr)).toBe(42)
    expect(isJobEmpty(exited, 50n as NativePtr)).toBe(true)
  })

  it('reports wait and exit-code query failures', () => {
    const processWait = api({ waitForSingleObject: vi.fn(() => 0xFFFFFFFF) })
    expect(() => pollProcessExit(processWait, 60n as NativePtr)).toThrow(Win32Error)

    const exitCode = api({ getExitCodeProcess: vi.fn(() => 0) })
    expect(() => pollProcessExit(exitCode, 60n as NativePtr)).toThrow(Win32Error)

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

  it('probes an unnamed Job and closes its handle', () => {
    const closeHandle = vi.fn(() => 1)
    const bindings = api({ closeHandle })
    expect(() => { probeCurrentTokenJobSupport(bindings) }).not.toThrow()
    expect(closeHandle).toHaveBeenCalledExactlyOnceWith(50n)
  })

  it('rejects an unavailable carrier descriptor or CRT binding before target creation', () => {
    const closeHandle = vi.fn(() => 1)
    const missingDescriptor = api({ closeHandle, getOsfHandle: vi.fn(() => -1) })
    expect(() => spawnCurrentTokenJobProcess(missingDescriptor, {
      command: 'probe.exe',
      args: [],
      cwd: 'C:\\work',
      stdio: { stdin: 4, stdout: 5, stderr: 6 },
    })).toThrow('_get_osfhandle failed for target stdin fd 4')
    expect(closeHandle).toHaveBeenCalledWith(50n)

    const missingBinding = api({ getOsfHandle: undefined as never })
    expect(() => { probeCurrentTokenJobSupport(missingBinding) })
      .toThrow('current-token Job support requires UCRT _get_osfhandle')
  })
})
