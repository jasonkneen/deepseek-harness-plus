/** One Electron release stream for the version-bound shell and dsh seed. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import electronUpdater, { type AppUpdater } from 'electron-updater'
import type { DesktopUpdateState } from './ipc.ts'
const { autoUpdater } = electronUpdater

/** Checks, downloads, and installs one complete Desktop release. */
export class DesktopUpdateCoordinator {
  private availableVersion: string | undefined
  private operation: Promise<DesktopUpdateState> | undefined

  /**
   * @param publish - state sink for every desktop window.
   * @param beforeRestart - stop application-owned processes before replacement.
   * @param updater - Electron artifact updater; replaceable for tests.
   * @param enabled - whether this packaged process carries updater configuration.
   */
  constructor(
    private readonly publish: (state: DesktopUpdateState) => DesktopUpdateState,
    private readonly beforeRestart: () => Promise<void> = async () => {},
    private readonly updater: AppUpdater = autoUpdater,
    private readonly enabled: () => boolean = () => (
      app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
    ),
  ) {
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
  }

  /** Check the configured Desktop release stream and retain an available version. */
  async check(): Promise<DesktopUpdateState> {
    if (this.operation !== undefined) return this.operation
    this.operation = this.doCheck().finally(() => { this.operation = undefined })
    return this.operation
  }

  /** Download and install the retained Desktop release. */
  async install(): Promise<DesktopUpdateState> {
    if (this.operation !== undefined) return this.operation
    this.operation = this.doInstall().finally(() => { this.operation = undefined })
    return this.operation
  }

  private async doCheck(): Promise<DesktopUpdateState> {
    this.publish({ phase: 'checking' })
    try {
      if (!this.enabled()) {
        this.availableVersion = undefined
        return this.publish({ phase: 'idle', message: '当前已是最新版本。' })
      }
      const result = await this.updater.checkForUpdates()
      const version = result?.isUpdateAvailable === true ? result.updateInfo.version : undefined
      this.availableVersion = version
      return version === undefined
        ? this.publish({ phase: 'idle', message: '当前已是最新版本。' })
        : this.publish({ phase: 'available', version })
    } catch (error) {
      this.availableVersion = undefined
      return this.publish({
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async doInstall(): Promise<DesktopUpdateState> {
    const version = this.availableVersion
    if (version === undefined) {
      throw new Error('desktop update: no verified update is available')
    }
    this.publish({ phase: 'installing', version })
    try {
      await this.updater.downloadUpdate()
      this.availableVersion = undefined
      const ready = this.publish({ phase: 'ready', version })
      await this.beforeRestart()
      this.updater.quitAndInstall(false, true)
      return ready
    } catch (error) {
      return this.publish({
        phase: 'error',
        version,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
