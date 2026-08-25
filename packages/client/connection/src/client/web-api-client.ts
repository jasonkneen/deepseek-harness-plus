/** Browser API carrier for unary HTTP calls. */

import { AbstractApiClient } from './api.ts'

/** Browser platform subclass supplying fetch for unary calls. */
export class WebApiClient extends AbstractApiClient {
  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init)
  }
}
