import koffi from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import {
  closeHandleChecked,
  closeCurrentProcessStandardStreams,
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
  STD_ERROR_HANDLE,
  STD_INPUT_HANDLE,
  STD_OUTPUT_HANDLE,
  WAIT_TIMEOUT,
} from '../src/abi.ts'
import { PROCESS_INFORMATION, STARTUPINFOW } from '../src/ffi.ts'
import type { NativePtr, Win32ProcessBindings } from '../src/index.ts'

function api(overrides: Partial<Win32ProcessBindings> = {}): Win32ProcessBindings {
  return {
    createJobObjectW: vi.fn(() => 50n),
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
      spawnCurrentTokenJobProcess(bindings, { command: 'missing.exe', args: [], cwd: 'C:\\work' })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ api: 'CreateProcessW', win32Code: 5 })
  })

  it('inherits the runner standard handles and restores their flags', () => {
    let startup: Record<string, unknown> | undefined
    const handles = new Map([
      [STD_INPUT_HANDLE, 71n as NativePtr],
      [STD_OUTPUT_HANDLE, 72n as NativePtr],
      [STD_ERROR_HANDLE, 73n as NativePtr],
    ])
    const getStdHandle = vi.fn((selector: number) => handles.get(selector) as NativePtr)
    const setHandleInformation = vi.fn(() => 1)
    const bindings = api({
      getStdHandle,
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
    })).toEqual({ pid: 1234, process: 60n, job: 50n })
    expect(getStdHandle.mock.calls.map(([selector]) => selector)).toEqual([
      STD_INPUT_HANDLE,
      STD_OUTPUT_HANDLE,
      STD_ERROR_HANDLE,
    ])
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

  it('closes each runner descriptor and materialized output handle', () => {
    const closeDescriptor = vi.fn()
    const input = { destroyed: false, destroy: vi.fn() }
    const sharedHandle = { close: vi.fn() }
    const output = { destroyed: false, destroy: vi.fn(), _handle: sharedHandle }
    const alreadyClosed = { destroyed: true, destroy: vi.fn(), _handle: { close: vi.fn() } }

    expect(() => {
      closeCurrentProcessStandardStreams([input, output, output], closeDescriptor)
    }).not.toThrow()
    expect(input.destroy).toHaveBeenCalledOnce()
    expect(output.destroy).not.toHaveBeenCalled()
    expect(sharedHandle.close).toHaveBeenCalledOnce()
    expect(closeDescriptor.mock.calls).toEqual([[0], [1], [2]])

    expect(() => {
      closeCurrentProcessStandardStreams([alreadyClosed, alreadyClosed, alreadyClosed], closeDescriptor)
    }).not.toThrow()
    expect(alreadyClosed.destroy).not.toHaveBeenCalled()
    expect(alreadyClosed._handle.close).not.toHaveBeenCalled()
  })

  it('reports one or several runner standard-stream close failures', () => {
    const closed = { destroyed: true, destroy: vi.fn() }
    expect(() => {
      closeCurrentProcessStandardStreams([
        { destroyed: false, destroy: () => { throw new Error('single close failure') } },
        closed,
        closed,
      ], vi.fn((fd: number) => {
        if (fd === 0) throw Object.assign(new Error('already closed'), { code: 'EBADF' })
      }))
    }).toThrow('single close failure')

    let failure: unknown
    try {
      closeCurrentProcessStandardStreams([
        closed,
        { destroyed: false, destroy: vi.fn(), _handle: { close: () => { throw 'raw close failure' } } },
        { destroyed: false, destroy: vi.fn(), _handle: { close: () => { throw new Error('second close failure') } } },
      ], (fd) => {
        if (fd === 1) throw new Error('descriptor close failure')
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      name: 'AggregateError',
      message: 'closing runner standard streams failed',
    })
    const errors = (failure as { errors: unknown }).errors
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'raw close failure' }),
      expect.objectContaining({ message: 'second close failure' }),
      expect.objectContaining({ message: 'descriptor close failure' }),
    ]))
  })
})
