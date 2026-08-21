/**
 * Page half: everything a deployment needs to reach a worker-hosted harness.
 *
 * This is **pre-Cordis glue, not a client plugin**: it installs the transport
 * global and executes the boot injection table that the client plugin graph
 * is later loaded through, so it cannot itself be a graph row. A page imports
 * it directly and decides where the worker bundle and image live; nothing
 * here mounts into a shipped roster.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/client
 */
import { IMAGE_FILE_NAME } from '../image-layout.ts'
import { WorkerApiClient } from './api-client.ts'
import { WorkerTunnel, type TunnelFetch } from './client.ts'
import { applyIndexInjections } from './apply-injections.ts'

export { WorkerApiClient } from './api-client.ts'
export { WorkerTunnel, type TunnelFetch } from './client.ts'
export { applyIndexInjections } from './apply-injections.ts'
export { IMAGE_FILE_NAME } from '../image-layout.ts'

/** Transport global the connection plugin reads instead of building an HTTP carrier. */
interface ClientTransportGlobal {
  __DSH_TRANSPORT__?: {
    createApiClient: () => WorkerApiClient
    fetch: TunnelFetch
    loadBundle: (url: string) => Promise<void>
    /** The page spawned the worker the Host runs in, so the page owns it. */
    ownsHost: boolean
  }
}

/** Inputs for {@link connectWorkerHost}. */
export interface WorkerHostConnectOptions {
  /**
   * VFS image URL, the one deployment-shaped input. Defaults to
   * {@link IMAGE_FILE_NAME} beside the page; a deployment that packs the
   * image elsewhere passes its own URL.
   */
  readonly image?: string | URL
}

/** A page connected to a worker-hosted harness, ready to run a shell entry. */
export interface WorkerHostConnection {
  readonly worker: Worker
  readonly tunnel: WorkerTunnel
  /** Bundle transport for the shell's boot seam. */
  loadBundle(url: string): Promise<void>
}

/** Boot-readiness deferred shared with the client entry's pre-boot await. */
interface BootReadyGlobal {
  __DSH_BOOT_READY__?: PromiseWithResolvers<void>
}

/**
 * Connect a spawned host worker and complete the pre-Cordis handshake.
 *
 * The caller constructs the Worker so its bundler resolves the bundle URL
 * statically; the opening `init` frame then carries the image location, the
 * only input the worker takes from outside.
 *
 * Order is fixed by the web boot protocol: the transport global must exist
 * before any bundle executes; the injection table then reproduces the served
 * boot rows — the `__ModuleLoader__` registration queue, the parser-preload
 * bundles, `__DSH_BOOT__`, the theme bootstrap — in table order. The
 * boot-readiness deferred (`__DSH_BOOT_READY__`) is installed before the
 * first await and settles with the handshake, so a client entry evaluating
 * concurrently in the same document holds at its pre-boot await until every
 * row has taken effect, and surfaces a failed handshake instead of
 * proceeding on missing globals.
 * @param worker - The host worker.
 * @param options - Image location override.
 * @returns The connection; hand `loadBundle` to the shell entry's boot seam.
 */
export async function connectWorkerHost(worker: Worker, options?: WorkerHostConnectOptions): Promise<WorkerHostConnection> {
  const ready = (globalThis as BootReadyGlobal).__DSH_BOOT_READY__ ??= Promise.withResolvers<void>()
  // The handshake may fail before any entry awaits the promise; this no-op
  // subscription keeps that from surfacing as an unhandled rejection.
  void ready.promise.catch(() => {})
  try {
    const tunnel = new WorkerTunnel(worker)
    tunnel.init(new URL(options?.image ?? IMAGE_FILE_NAME, document.baseURI).href)
    const payload = await tunnel.bootPayload()
    ;(globalThis as ClientTransportGlobal).__DSH_TRANSPORT__ = {
      createApiClient: () => new WorkerApiClient(tunnel),
      fetch: (input, init) => tunnel.fetch(input, init),
      loadBundle: (url: string) => tunnel.loadBundle(url),
      // The host lives in a worker this page spawned: the page owns it, so
      // the privileged surface stays reachable off loopback authorities.
      ownsHost: true,
    }
    await applyIndexInjections(payload.injections, src => tunnel.loadBundle(src))
    ready.resolve()
    return { worker, tunnel, loadBundle: (url: string) => tunnel.loadBundle(url) }
  } catch (reason) {
    ready.reject(reason)
    throw reason
  }
}
