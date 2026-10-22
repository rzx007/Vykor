import type { DesktopUpdateState } from "../../../shared/update-types"

/** The first update check runs this long after the main window is shown. */
export const UPDATE_CHECK_DELAY_MS = 8_000
/** A running app re-checks every two hours, so it still learns about a new release. */
export const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1_000

interface UpdateInfo {
  version: string
}

interface DownloadProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

type UpdaterEvent =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error"

interface UpdaterAdapter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
  on(event: UpdaterEvent, listener: (...args: any[]) => void): unknown
  removeListener(event: UpdaterEvent, listener: (...args: any[]) => void): unknown
}

interface UpdaterLogger {
  info(message: string): void
  error(message: string, error?: unknown): void
}

interface UpdaterServiceDependencies {
  updater: UpdaterAdapter
  isPackaged: boolean
  platform: string
  checkDelayMs: number
  checkIntervalMs: number
  logger: UpdaterLogger
  setForceQuit(value: boolean): void
}

export interface UpdaterService {
  startAfterWindowShown(): void
  getState(): DesktopUpdateState
  subscribe(listener: (state: DesktopUpdateState) => void): () => void
  download(): Promise<void>
  install(): void
  dispose(): void
}

export function createUpdaterService(dependencies: UpdaterServiceDependencies): UpdaterService {
  const enabled =
    dependencies.isPackaged &&
    (dependencies.platform === "win32" || dependencies.platform === "linux")
  let started = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let state: DesktopUpdateState = { status: "idle" }
  let availableVersion: string | undefined
  let userDownloadPending = false
  const subscribers = new Set<(state: DesktopUpdateState) => void>()

  const publish = (next: DesktopUpdateState): void => {
    state = next
    for (const subscriber of subscribers) subscriber(next)
  }

  const listeners: Array<[UpdaterEvent, (...args: any[]) => void]> = [
    ["checking-for-update", () => publish({ status: "checking" })],
    [
      "update-available",
      (info: UpdateInfo) => {
        availableVersion = info.version
        if (dependencies.updater.autoDownload) {
          publish({
            status: "downloading",
            version: info.version,
            percent: 0,
            transferred: 0,
            total: 0,
            bytesPerSecond: 0,
          })
          return
        }
        publish({ status: "available", version: info.version })
      },
    ],
    ["update-not-available", () => publish({ status: "idle" })],
    [
      "download-progress",
      (progress: DownloadProgress) => {
        publish({
          status: "downloading",
          version: availableVersion ?? currentVersion(state) ?? "",
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
          bytesPerSecond: progress.bytesPerSecond,
        })
      },
    ],
    [
      "update-downloaded",
      (info: UpdateInfo) => {
        availableVersion = info.version
        publish({ status: "downloaded", version: info.version })
      },
    ],
    [
      "error",
      (error: unknown) => {
        if (userDownloadPending || state.status === "available" || state.status === "downloading") {
          publish({
            status: "error",
            version: availableVersion,
            message: errorMessage(error),
          })
        } else {
          dependencies.logger.error("Background update check failed", error)
          publish({ status: "idle" })
        }
      },
    ],
  ]

  if (enabled) {
    dependencies.updater.autoDownload = true
    dependencies.updater.autoInstallOnAppQuit = true
    for (const [event, listener] of listeners) dependencies.updater.on(event, listener)
  }

  // One timer drives every check: the first one after checkDelayMs, then one every
  // checkIntervalMs for as long as the app runs.
  const runScheduledCheck = (): void => {
    timer = null
    // A periodic check must not restart a download the user is already waiting for.
    const busy =
      state.status === "downloading" || state.status === "downloaded" || state.status === "available"
    if (!busy) {
      publish({ status: "checking" })
      void dependencies.updater.checkForUpdates().catch((error: unknown) => {
        dependencies.logger.error("Background update check failed", error)
        if (state.status === "checking") publish({ status: "idle" })
      })
    }
    timer = setTimeout(runScheduledCheck, dependencies.checkIntervalMs)
  }

  return {
    startAfterWindowShown(): void {
      if (!enabled || started) return
      started = true
      timer = setTimeout(runScheduledCheck, dependencies.checkDelayMs)
    },
    getState: () => state,
    subscribe(listener): () => void {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
    async download(): Promise<void> {
      if (!enabled || state.status !== "available") return
      userDownloadPending = true
      publish({
        status: "downloading",
        version: state.version,
        percent: 0,
        transferred: 0,
        total: 0,
        bytesPerSecond: 0,
      })
      try {
        await dependencies.updater.downloadUpdate()
      } catch (error) {
        publish({
          status: "error",
          version: availableVersion,
          message: errorMessage(error),
        })
        throw error
      } finally {
        userDownloadPending = false
      }
    },
    install(): void {
      if (!enabled || state.status !== "downloaded") return
      dependencies.setForceQuit(true)
      dependencies.updater.quitAndInstall()
    },
    dispose(): void {
      if (timer) clearTimeout(timer)
      timer = null
      for (const [event, listener] of listeners) {
        dependencies.updater.removeListener(event, listener)
      }
      subscribers.clear()
    },
  }
}

function currentVersion(state: DesktopUpdateState): string | undefined {
  return "version" in state ? state.version : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
