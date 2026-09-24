import { app, BrowserWindow, Menu } from "electron"
import { electronApp, optimizer, is } from "@electron-toolkit/utils"

import { createAppContext, type AppContext } from "./core/app-context"
import { IpcRegistry } from "./core/ipc/registry"
import { quitApp } from "./core/services/lifecycle"
import { WindowManager } from "./core/services/window-manager"
import { allIpcContributions } from "./features"
import { createMainWindow, showMainWindow } from "./features/main-window/window"
import { createPetWindow } from "./features/pet/window"
import { desktopSessionService } from "./features/session/session-service"
import { desktopTerminalService } from "./features/terminal/terminal-service"
import { createTray, destroyTray } from "./features/tray/tray"
import { startDesktopUpdater } from "./features/updater/start"
import {
  resolveDesktopDaemonMode,
  runDesktopDaemonEntry,
} from "./features/daemon-autostart/daemon-entry"
import icon from "../../resources/icon.png?asset"

let ctx: AppContext | null = null
let ipcRegistry: IpcRegistry | null = null
let updaterRuntime: ReturnType<typeof startDesktopUpdater> | null = null

const daemonMode = resolveDesktopDaemonMode(process.argv)
if (daemonMode) {
  void app
    .whenReady()
    .then(() => runDesktopDaemonEntry(daemonMode))
    .catch((error: unknown) => {
      console.error("[daemon] Desktop service failed", error)
      app.exit(1)
    })
} else {
  startDesktopApplication()
}

function startDesktopApplication(): void {
  if (process.platform === "linux") {
    app.commandLine.appendSwitch("enable-transparent-visuals")
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    process.exit(0)
  }

  app.whenReady().then(() => {
    electronApp.setAppUserModelId(is.dev ? "dev.vykor.desktop" : "app.vykor.desktop")
    app.setName("Vykor")
    Menu.setApplicationMenu(null)

    app.on("browser-window-created", (_, window) => {
      optimizer.watchWindowShortcuts(window)
      window.webContents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown" || input.key !== "F12") return
        if (input.control || input.meta || input.alt) return

        event.preventDefault()
        window.webContents.toggleDevTools()
      })
    })

    const windowManager = new WindowManager()
    ctx = createAppContext({
      mainDirname: __dirname,
      rendererUrl: is.dev ? process.env["ELECTRON_RENDERER_URL"] : undefined,
      iconPath: icon,
      windowManager,
      createMainWindow: () => createMainWindow(requireContext()),
    })

    ipcRegistry = new IpcRegistry(ctx)
    updaterRuntime = startDesktopUpdater()
    for (const contribution of [...allIpcContributions, updaterRuntime.contribution]) {
      ipcRegistry.register(contribution)
    }

    const mainWindow = createMainWindow(ctx)
    createTray(ctx)
    createPetWindow(ctx)
    showMainWindow(mainWindow)
    updaterRuntime.service.startAfterWindowShown()
  })

  app.on("activate", () => {
    if (!ctx) return
    const appContext = requireContext()
    const mainWindow = appContext.windowManager.getMain() ?? createMainWindow(appContext)
    showMainWindow(mainWindow)
  })

  app.on("second-instance", () => {
    if (!ctx) return
    const appContext = requireContext()
    const mainWindow = appContext.windowManager.getMain() ?? createMainWindow(appContext)
    showMainWindow(mainWindow)
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && BrowserWindow.getAllWindows().length === 0) {
      quitApp()
    }
  })

  app.on("before-quit", () => {
    updaterRuntime?.service.dispose()
    updaterRuntime = null
    ipcRegistry?.dispose()
    destroyTray()
    void desktopTerminalService.dispose()
    void desktopSessionService.dispose()
  })
}

function requireContext(): AppContext {
  if (!ctx) throw new Error("AppContext is not initialized")
  return ctx
}
