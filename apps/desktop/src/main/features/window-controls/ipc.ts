import { app, BrowserWindow, shell } from "electron"

import { IpcChannels, type DesktopAppInfo, type PlatformInfo } from "../../../shared/ipc-channels"
import type { IpcContribution } from "../../core/ipc/types"
import { quitApp, setForceQuit } from "../../core/services/lifecycle"
import {
  currentMainWindowMaterialState,
  setMainWindowMaterial,
  showMainWindow,
} from "../main-window/window"
import { normalizeZoomLevel } from "../../../shared/zoom"
import { isDesktopWindowMaterialPreference } from "../../../shared/window-material-types"
import { openUrlInDefaultBrowser } from "./open-external-url"

export const windowControlsIpcContribution: IpcContribution = {
  id: "window-controls",
  register(ctx) {
    return [
      {
        channel: IpcChannels.appGetInfo,
        handler: (): DesktopAppInfo => ({
          name: app.getName(),
          version: app.getVersion(),
          isPackaged: app.isPackaged,
        }),
      },
      {
        channel: IpcChannels.appGetPlatform,
        handler: (): PlatformInfo => ({
          platform: process.platform,
          isMac: process.platform === "darwin",
          isWindows: process.platform === "win32",
          isLinux: process.platform === "linux",
        }),
      },
      {
        channel: IpcChannels.appQuit,
        handler: () => quitApp(),
      },
      {
        channel: IpcChannels.windowShowMain,
        handler: () => showMainWindow(ctx.windowManager.getMain() ?? ctx.createMainWindow()),
      },
      {
        channel: IpcChannels.windowMinimize,
        handler: (event) => getEventWindow(event.sender)?.minimize(),
      },
      {
        channel: IpcChannels.windowClose,
        handler: (event) => getEventWindow(event.sender)?.close(),
      },
      {
        channel: IpcChannels.windowToggleMaximize,
        handler: (event) => {
          const win = getEventWindow(event.sender)
          if (!win) return
          if (win.isMaximized()) win.unmaximize()
          else win.maximize()
        },
      },
      {
        channel: IpcChannels.windowIsMaximized,
        handler: (event) => Boolean(getEventWindow(event.sender)?.isMaximized()),
      },
      {
        channel: IpcChannels.windowGetZoomLevel,
        handler: (event) => event.sender.getZoomLevel(),
      },
      {
        channel: IpcChannels.windowSetZoomLevel,
        handler: (event, level) => {
          const normalizedLevel = normalizeZoomLevel(Number(level))
          event.sender.setZoomLevel(normalizedLevel)
          return normalizedLevel
        },
      },
      {
        channel: IpcChannels.windowOpenExternal,
        handler: (_event, url) =>
          openUrlInDefaultBrowser(url, {
            openExternal: (target) => shell.openExternal(target),
            openPath: (path) => shell.openPath(path),
          }),
      },
      {
        channel: IpcChannels.windowGetMaterial,
        handler: () => currentMainWindowMaterialState(),
      },
      {
        channel: IpcChannels.windowSetMaterial,
        handler: (event, preference) => {
          if (!isDesktopWindowMaterialPreference(preference)) {
            throw new Error("未知的窗口材质设置。")
          }
          const win = getEventWindow(event.sender)
          if (!win) throw new Error("窗口不存在，无法切换窗口材质。")
          return setMainWindowMaterial(win, preference)
        },
      },
    ]
  },
}

app.on("before-quit", () => {
  setForceQuit(true)
})

function getEventWindow(webContents: Electron.WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(webContents)
}
