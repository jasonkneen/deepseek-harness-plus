/** Generic unary RPC contracts shared by the Host and Client Connection halves. */

/** Carrier-neutral failure returned by one logical RPC endpoint. */
export interface ConnectionRpcFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** Carrier-neutral result returned by one logical RPC endpoint. */
export type ConnectionRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ConnectionRpcFailure }

/** HTTP request facts consumed by browser trust and authentication. */
export interface ConnectionTrustRequest {
  /** Request headers supplied by either the Fetch or node:http representation. */
  readonly headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>
}

/** HTTP status returned before dispatch, or undefined when the request may proceed. */
export type ConnectionRequestRejection = 401 | 403 | undefined

/** Root/index request facts used by the browser-token exchange. */
export interface ConnectionIndexRequest extends ConnectionTrustRequest {
  readonly method?: string | undefined
  readonly url?: string | undefined
}

/** Root/index response operations owned by the browser-token exchange. */
export interface ConnectionIndexResponse {
  writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown
  end(body?: string): unknown
}

/** Handler invoked after Connection has decoded the transport envelope. */
export type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<ConnectionRpcResult<unknown>>

/** Synchronous ownership test for one endpoint on a shared RPC channel. */
export type ConnectionRpcEndpointMatcher = (endpoint: string) => boolean

/** Host registry for logical RPC channels carried by the current transport. */
export interface HostConnectionRpc {
  /**
   * Register one authenticated absolute channel prefix.
   * @param channel - absolute logical channel such as `/rpc`.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @returns asynchronous disposer removing the channel and its physical route.
   */
  handle(
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void>

  /**
   * Intercept owned endpoints on the shared `/api` channel before its fallback.
   * @param channel - reserved shared channel; currently `/api`.
   * @param matches - synchronous endpoint ownership test.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @returns asynchronous disposer removing the interceptor.
   */
  intercept(
    channel: '/api',
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void>
}

/** Host `ctx.connection` shape consumed by transport-independent adapters. */
export interface HostConnectionHandle {
  /** Generic RPC channel registry. */
  readonly rpc: HostConnectionRpc

  /**
   * Apply Connection's Host/Origin checks and browser authentication to
   * another Web route.
   * @param request - request headers from the HTTP or upgrade request.
   * @returns rejection status, or undefined when the route may accept the request.
   */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection

  /**
   * Authenticate one frontend index request, owning a token redirect or 401.
   * @param request - root or configured-index HTTP request.
   * @param response - response owned when the result is false.
   * @returns true only when the frontend may serve index.html.
   */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean

  /**
   * Add the fresh process token to an ordinary Web application URL.
   * @param baseUrl - clean canonical browser origin.
   * @returns root URL accepted by {@link authorizeIndex} for initial login.
   */
  authenticatedUrl(baseUrl: string): string
}

/** Client caller for logical RPC channels carried by the current transport. */
export interface ClientConnectionRpc {
  /**
   * Call one endpoint through an already registered logical channel.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `goals/create`.
   * @param payload - channel-owned request payload.
   * @param signal - optional caller cancellation.
   * @returns the endpoint-owned success/error result; correlation stays inside Connection.
   */
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<ConnectionRpcResult<unknown>>

  /**
   * Open an in-process logical stream when the selected carrier supplies one.
   * Browser transports omit this method; API Gateway owns their WebSocket mux.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `session/follow`.
   * @param payload - channel-owned request payload.
   * @param signal - caller cancellation for this logical stream.
   * @returns decoded stream values from the in-process carrier.
   */
  readonly open?: (
    channel: string,
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ) => AsyncIterable<unknown>
}
