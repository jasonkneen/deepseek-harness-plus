import koffi from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import {
  closeHandleChecked,
  isJobEmpty,
  pollProcessExit,
  spawnOrdinaryJobProcess,
  terminateJob,
  Win32Error,
} from '../src/index.ts'
import { CREATE_SUSPENDED, WAIT_TIMEOUT } from '../src/abi.ts'
import { PROCESS_INFORMATION } from '../src/ffi.ts'
import type { NativePtr, Win32ProcessBindings } from '../src/index.ts'

function api(overrides: Partial<Win32ProcessBindings> = {}): Win32ProcessBindings {
  return {
    createJobObjectW: vi.fn(() => 50n),
    setInformationJobObject: vi.fn(() => 1),
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
    expect(spawnOrdinaryJobProcess(bindings, {
      command: 'probe.exe',
      args: ['literal $VALUE', 'a b'],
      cwd: 'C:\\work',
    })).toEqual({ pid: 1234, process: 60n, job: 50n })
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
      spawnOrdinaryJobProcess(bindings, { command: 'missing.exe', args: [], cwd: 'C:\\work' })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ api: 'CreateProcessW', win32Code: 5 })
  })

  it('polls direct exit and Job emptiness without blocking', () => {
    const running = api({ waitForSingleObject: vi.fn(() => WAIT_TIMEOUT) })
    expect(pollProcessExit(running, 60n as NativePtr)).toBeUndefined()
    expect(isJobEmpty(running, 50n as NativePtr)).toBe(false)

    const exited = api()
    expect(pollProcessExit(exited, 60n as NativePtr)).toBe(42)
    expect(isJobEmpty(exited, 50n as NativePtr)).toBe(true)
  })

  it('checks Job termination and caller-owned handle closure', () => {
    const terminateJobObject = vi.fn(() => 1)
    const bindings = api({ terminateJobObject })
    expect(() => { terminateJob(bindings, 50n as NativePtr, 1) }).not.toThrow()
    expect(() => { closeHandleChecked(bindings, 50n as NativePtr, 'test Job') }).not.toThrow()
    expect(terminateJobObject).toHaveBeenCalledWith(50n, 1)

    const failing = api({ terminateJobObject: vi.fn(() => 0) })
    expect(() => { terminateJob(failing, 50n as NativePtr, 1) }).toThrow(Win32Error)
  })
})
