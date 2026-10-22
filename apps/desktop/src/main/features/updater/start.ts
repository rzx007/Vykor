import { app, BrowserWindow } from "electron"
import log from "electron-log/main"
import { autoUpdater } from "electron-updater"

import { IpcEvents } from "../../../shared/ipc-channels"
import { setForceQuit } from "../../core/services/lifecycle"
import type { IpcContribution } from "../../core/ipc/types"
import { createUpdaterIpcContribution } from "./ipc"
import { createUpdaterService, UPDATE_CHECK_DELAY_MS, UPDATE_CHECK_INTERVAL_MS, type UpdaterService } from "./updater-service"

export interface DesktopUpdaterRuntime {
  service: UpdaterService
  contribution: IpcContribution
}

export function startDesktopUpdater(): DesktopUpdaterRuntime {
  autoUpdater.logger = log
  const service = createUpdaterService({
    updater: autoUpdater as Parameters<typeof createUpdaterService>[0]["updater"],
    isPackaged: app.isPackaged,
    platform: process.platform,
    checkDelayMs: UPDATE_CHECK_DELAY_MS,
    checkIntervalMs: UPDATE_CHECK_INTERVAL_MS,
    logger: {
      info: (message) => log.info(`[updater] ${message}`),
      error: (message, error) => log.error(`[updater] ${message}`, error),
    },
    setForceQuit,
  })

  const contribution = createUpdaterIpcContribution({
    service,
    broadcast: (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(IpcEvents.updateStateChanged, state)
        }
      }
    },
  })

  return { service, contribution }
}
