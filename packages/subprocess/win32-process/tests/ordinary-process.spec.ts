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

  it('closes unique raw handles and restores output Socket destruction', () => {
    const input = { destroyed: false, destroy: vi.fn() }
    const socketDestroy = vi.fn()
    const dummyDestroy = vi.fn()
    const makeOutput = (): {
      stream: { destroyed: boolean; destroy(): void; _destroy?: () => void }
      destroy: ReturnType<typeof vi.fn>
    } => {
      const destroy = vi.fn(function (this: { _destroy(): void }) { this._destroy() })
      const stream = Object.assign(Object.create({ _destroy: socketDestroy }), {
        destroyed: false,
        destroy,
        _destroy: dummyDestroy,
      }) as { destroyed: boolean; destroy(): void; _destroy?: () => void }
      return { stream, destroy }
    }
    const { stream: stdout, destroy: stdoutDestroy } = makeOutput()
    const { stream: stderr, destroy: stderrDestroy } = makeOutput()
    const closeHandle = vi.fn(() => 1)
    const getStdHandle = vi.fn((selector: number) =>
      (selector === STD_INPUT_HANDLE ? 10n : 11n) as NativePtr)
    const bindings = api({
      getStdHandle,
      closeHandle,
    })

    expect(() => {
      closeCurrentProcessStandardStreams(bindings, [input, stdout, stderr])
    }).not.toThrow()
    expect(getStdHandle).toHaveBeenCalledTimes(3)
    expect(closeHandle.mock.calls).toEqual([[10n], [11n]])
    expect(input.destroy).toHaveBeenCalledOnce()
    expect(stdoutDestroy).toHaveBeenCalledOnce()
    expect(stderrDestroy).toHaveBeenCalledOnce()
    expect(dummyDestroy).not.toHaveBeenCalled()
    expect(socketDestroy).toHaveBeenCalledTimes(2)
    expect(Object.hasOwn(stdout, '_destroy')).toBe(false)
    expect(Object.hasOwn(stderr, '_destroy')).toBe(false)
  })

  it('reports one or several runner standard-stream close failures', () => {
    const closed = { destroyed: true, destroy: vi.fn() }
    let getStdHandleCalls = 0
    const getStdHandle = vi.fn(() => {
      getStdHandleCalls += 1
      if (getStdHandleCalls === 1) throw new Error('single close failure')
      return 0n as NativePtr
    })
    const singleFailure = api({ getStdHandle })
    expect(() => {
      closeCurrentProcessStandardStreams(singleFailure, [
        closed,
        closed,
        closed,
      ])
    }).toThrow('single close failure')
    expect(getStdHandle).toHaveBeenCalledTimes(3)

    const rawCloseFailure = api({ closeHandle: vi.fn(() => 0) })
    const nonConfigurableDestroy = vi.fn()
    const nonConfigurable = {
      destroyed: false,
      destroy: nonConfigurableDestroy,
    } as { destroyed: boolean; destroy(): void; _destroy?: unknown }
    Object.defineProperty(nonConfigurable, '_destroy', { value: vi.fn(), configurable: false })
    let failure: unknown
    try {
      closeCurrentProcessStandardStreams(rawCloseFailure, [
        { destroyed: false, destroy: () => { throw 'input close failure' } },
        nonConfigurable,
        { destroyed: false, destroy: () => { throw new Error('output close failure') } },
      ])
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      name: 'AggregateError',
      message: 'closing runner standard streams failed',
    })
    const errors = (failure as { errors: unknown }).errors
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ api: 'CloseHandle' }),
      expect.objectContaining({ message: 'input close failure' }),
      expect.objectContaining({ message: 'deleting runner standard-stream destroy override failed' }),
      expect.objectContaining({ message: 'output close failure' }),
    ]))
    expect(nonConfigurableDestroy).toHaveBeenCalledOnce()
  })
})
