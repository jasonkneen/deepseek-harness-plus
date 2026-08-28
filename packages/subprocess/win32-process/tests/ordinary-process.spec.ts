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
  CREATE_UNICODE_ENVIRONMENT,
  CRT_FOPEN,
  INHERITED_STDIO_COUNT_SIZE,
  INHERITED_STDIO_HANDLE_SIZE,
  JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET,
  JOBOBJECT_BASIC_ACCOUNTING_SIZE,
  JobObjectBasicAccountingInformation,
  WAIT_TIMEOUT,
} from '../src/abi.ts'
import { PROCESS_INFORMATION, STARTUPINFOW } from '../src/ffi.ts'
import type {
  CurrentTokenProcessSpawnOptions,
  CurrentTokenProcessBindings,
  NativePtr,
} from '../src/index.ts'

function inheritedStdioTable(count = 7): Buffer {
  const table = Buffer.alloc(
    INHERITED_STDIO_COUNT_SIZE + count + count * INHERITED_STDIO_HANDLE_SIZE,
  )
  table.writeUInt32LE(count, 0)
  for (let fileDescriptor = 0; fileDescriptor < count; fileDescriptor++) {
    table[INHERITED_STDIO_COUNT_SIZE + fileDescriptor] = CRT_FOPEN
    table.writeBigUInt64LE(
      BigInt(100 + fileDescriptor),
      INHERITED_STDIO_COUNT_SIZE + count + fileDescriptor * INHERITED_STDIO_HANDLE_SIZE,
    )
  }
  return table
}

function startupInfo(
  table: Buffer | null,
  size = table?.length ?? 0,
): CurrentTokenProcessBindings['getStartupInfoW'] {
  return vi.fn((startup: NativePtr) => {
    koffi.encode(startup, STARTUPINFOW, { cbReserved2: size, lpReserved2: table })
  })
}

function options(
  overrides: Partial<CurrentTokenProcessSpawnOptions> = {},
): CurrentTokenProcessSpawnOptions {
  return {
    command: 'probe.exe',
    applicationName: 'C:\\resolved\\probe.exe',
    args: [],
    cwd: 'C:\\work',
    env: {},
    stdio: { stdin: 4, stdout: 5, stderr: 6 },
    ...overrides,
  }
}

function api(overrides: Partial<CurrentTokenProcessBindings> = {}): CurrentTokenProcessBindings {
  const table = inheritedStdioTable()
  return {
    createJobObjectW: vi.fn(() => 50n),
    setInformationJobObject: vi.fn(() => 1),
    queryInformationJobObject: vi.fn((_job: NativePtr, _cls: number, information: Buffer) => {
      information.writeUInt32LE(0, JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET)
      return 1
    }),
    getStdHandle: vi.fn((selector: number) => BigInt(100 - selector)),
    getStartupInfoW: startupInfo(table),
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
    expect(spawnCurrentTokenJobProcess(bindings, options({
      args: ['literal $VALUE', 'a b'],
      env: { ZED: 'last', '=C:': 'C:\\work', alpha: 'first' },
    }))).toEqual({ pid: 1234, process: 60n, job: 50n })
    const environment = createProcessW.mock.calls[0]?.[6] as Buffer
    expect(createProcessW).toHaveBeenCalledWith(
      'C:\\resolved\\probe.exe',
      'probe.exe "literal $VALUE" "a b"',
      null,
      null,
      1,
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
      environment,
      'C:\\work',
      expect.anything(),
      expect.anything(),
    )
    expect(environment.toString('utf16le')).toBe('=C:=C:\\work\0alpha=first\0ZED=last\0\0')
    expect(events.indexOf('create')).toBeLessThan(events.indexOf('assign'))
    expect(events.indexOf('assign')).toBeLessThan(events.indexOf('resume'))
    expect(events).toContain('close:61')
  })

  it('reports CreateProcessW failure without replaying another creator', () => {
    const bindings = api({ createProcessW: vi.fn(() => 0) })
    let caught: unknown
    try {
      spawnCurrentTokenJobProcess(bindings, options({ command: 'missing.exe' }))
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ api: 'CreateProcessW', win32Code: 5 })
  })

  it('resolves the target carrier descriptors and restores their handle flags', () => {
    let startup: Record<string, unknown> | undefined
    const setHandleInformation = vi.fn(() => 1)
    const bindings = api({
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
    expect(spawnCurrentTokenJobProcess(bindings, options())).toEqual({ pid: 1234, process: 60n, job: 50n })
    expect(startup).toMatchObject({ hStdInput: 104n, hStdOutput: 105n, hStdError: 106n })
    expect(setHandleInformation.mock.calls).toEqual([
      [104n, 1, 1], [105n, 1, 1], [106n, 1, 1],
      [104n, 1, 0], [105n, 1, 0], [106n, 1, 0],
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

  it('strictly validates the inherited libuv descriptor table before target creation', () => {
    const expectFailure = (
      getStartupInfoW: CurrentTokenProcessBindings['getStartupInfoW'],
      message: string,
    ): void => {
      const closeHandle = vi.fn(() => 1)
      expect(() => spawnCurrentTokenJobProcess(api({ closeHandle, getStartupInfoW }), options()))
        .toThrow(message)
      expect(closeHandle).toHaveBeenCalledWith(50n)
    }

    expectFailure(startupInfo(null), 'no inherited stdio table')
    expectFailure(startupInfo(Buffer.alloc(3)), 'truncated inherited stdio table')

    const excessive = Buffer.alloc(INHERITED_STDIO_COUNT_SIZE)
    excessive.writeUInt32LE(257, 0)
    expectFailure(startupInfo(excessive), 'unsupported descriptor count 257')

    const truncated = Buffer.alloc(INHERITED_STDIO_COUNT_SIZE)
    truncated.writeUInt32LE(7, 0)
    expectFailure(startupInfo(truncated), 'truncated inherited stdio table')
    expectFailure(startupInfo(inheritedStdioTable(6)), 'missing target stderr fd 6')

    const closed = inheritedStdioTable()
    closed[INHERITED_STDIO_COUNT_SIZE + 4] = 0
    expectFailure(startupInfo(closed), 'marks target stdin fd 4 closed')

    for (const invalid of [0n, 0xFFFFFFFFFFFFFFFFn, 0xFFFFFFFFFFFFFFFEn]) {
      const table = inheritedStdioTable()
      table.writeBigUInt64LE(
        invalid,
        INHERITED_STDIO_COUNT_SIZE + 7 + 4 * INHERITED_STDIO_HANDLE_SIZE,
      )
      expectFailure(startupInfo(table), 'invalid handle for target stdin fd 4')
    }

    const missingBinding = api({ getStartupInfoW: undefined as never })
    expect(() => { probeCurrentTokenJobSupport(missingBinding) })
      .toThrow('current-token Job support requires GetStartupInfoW')
  })
})
