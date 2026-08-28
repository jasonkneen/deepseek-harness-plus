/** Electron-to-dsh child process messages. */

/** IPC protocol version implemented by the shell. */
export const DESKTOP_HOST_PROTOCOL_VERSION = 2 as const

/** One request forwarded from Electron's custom protocol handler. */
interface DesktopHostFetchCommand {
  readonly type: 'fetch'
  readonly id: string
  readonly request: {
    readonly url: string
    readonly method: string
    readonly headers: readonly [string, string][]
    readonly bodyBase64?: string
  }
}

/** Commands sent to the installed dsh child. */
export type DesktopHostCommand = DesktopHostFetchCommand | {
  readonly type: 'cancel'
  readonly id: string
} | {
  readonly type: 'shutdown'
}

/** Events accepted from the installed dsh child. */
export type DesktopHostEvent = {
  readonly type: 'ready'
  readonly protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  readonly dshVersion: string
} | {
  readonly type: 'response-start'
  readonly id: string
  readonly status: number
  readonly headers: readonly [string, string][]
} | {
  readonly type: 'response-chunk'
  readonly id: string
  readonly chunkBase64: string
} | {
  readonly type: 'response-end'
  readonly id: string
} | {
  readonly type: 'response-error'
  readonly id: string
  readonly message: string
} | {
  readonly type: 'fatal'
  readonly message: string
}
