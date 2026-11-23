import { flushDesktopBusinessData } from "./features/business-data/window-flush"
import { isDataRootMigrationShutdown } from "./features/settings/data-root-settings-service"
import { app, BrowserWindow, Menu, session, dialog, powerMonitor } from "electron"
import { resolve } from "node:path"
import { installDocumentPreviewProtocol } from "./features/workspace/document-preview-protocol"
import { electronApp, optimizer, is } from "@electron-toolkit/utils"

import { createAppContext, type AppContext } from "./core/app-context"
import { IpcRegistry } from "./core/ipc/registry"
import { quitApp, setForceQuit } from "./core/services/lifecycle"
import { WindowManager } from "./core/services/window-manager"
import { allIpcContributions } from "./features"
import { createMainWindow, showMainWindow } from "./features/main-window/window"
import { createPetWindow } from "./features/pet/window"
import { desktopSessionService } from "./features/session/session-service"
import { desktopTerminalService } from "./features/terminal/terminal-service"
import { desktopNoteService } from "./features/notes/note-service"
import { createTray, destroyTray } from "./features/tray/tray"
import { initializeNotificationActions } from "./features/tray/notification-actions"
import { openNotificationSession } from "./features/tray/notification-navigation"
import { startDesktopUpdater } from "./features/updater/start"
import {
  resolveDesktopDaemonMode,
  runDesktopDaemonEntry,
} from "./features/daemon-autostart/daemon-entry"
import icon from "../../resources/icon.png?asset"

import { installPluginAppDocumentProtocol, desktopPluginAppDocuments } from "./features/plugin-apps/document-protocol"
import { pluginAppMessageReady } from "./features/plugin-apps/message-ready"
import { clientForPluginApps } from "./features/plugin-apps/plugin-app-client"
import { DesktopPluginAppService } from "./features/plugin-apps/plugin-app-service"
import { setDesktopPluginAppService, getDesktopPluginAppService } from "./features/plugin-apps/service-runtime"

let ctx: AppContext | null = null
let ipcRegistry: IpcRegistry | null = null
let updaterRuntime: ReturnType<typeof startDesktopUpdater> | null = null

const daemonMode = resolveDesktopDaemonMode(process.argv)
if (daemonMode) {
  void app
    .whenReady()
    .then(() => runDesktopDaemonEntry(daemonMode))
    .then(() => app.quit())
    .catch((error: unknown) => {
      console.error("[daemon] Desktop service failed", error)
      app.exit(1)
    })
} else {
  startDesktopApplication()
}

function startDesktopApplication(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    process.exit(0)
  }

  app.whenReady().then(async () => {
    // Import before a renderer can start the daemon. A refused drain stays retryable from Notes.
    await desktopNoteService.initialize().catch((error) => {
      console.warn("[notes] 本地便签尚未准备好", error)
    })
    installDocumentPreviewProtocol(session.defaultSession, resolve(__dirname, "../document-preview"))
    installPluginAppDocumentProtocol(desktopPluginAppDocuments, session.defaultSession)
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

    const pluginApps = new DesktopPluginAppService({
      messageReady: pluginAppMessageReady,
      documents: desktopPluginAppDocuments,
      getClient: async () => {
        const agent = await desktopSessionService.agentClient()
        return clientForPluginApps(agent, await desktopSessionService.daemonTransport(agent))
      },
      getOwnerSessionToken: (id, sessionId) => desktopSessionService.subscriptions.getOwnerSessionToken(id, sessionId),
    })
    setDesktopPluginAppService(pluginApps)
    desktopSessionService.connection.onInvalidated(() => pluginApps.invalidateConnection())
    desktopSessionService.subscriptions.onOwnerSnapshot((id, view) => pluginApps.observeSession(id, view))

    ipcRegistry = new IpcRegistry(ctx)
    const disconnectComputer = () => { void desktopSessionService.disconnectComputer() }
    powerMonitor.on("suspend", disconnectComputer)
    powerMonitor.on("resume", disconnectComputer)
    powerMonitor.on("lock-screen", disconnectComputer)
    powerMonitor.on("shutdown", () => { void desktopSessionService.closeComputerAdmission() })
    updaterRuntime = startDesktopUpdater(() => desktopSessionService.closeComputerAdmission())
    for (const contribution of [...allIpcContributions, updaterRuntime.contribution]) {
      ipcRegistry.register(contribution)
    }

    const appContext = ctx
    initializeNotificationActions(
      () => desktopSessionService.agentClient(),
      (sessionId) => openNotificationSession(sessionId, () =>
        appContext.windowManager.getMain() ?? appContext.createMainWindow()
      )
    )

    const mainWindow = ctx.windowManager.getMain() ?? createMainWindow(ctx)
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

  let shutdown: Promise<void> | null = null
  let shutdownComplete = false
  app.on("before-quit", (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    if (shutdown) return
    const releasedComputer = desktopSessionService.closeComputerAdmission()
    shutdown = (async () => {
      if (!await releasedComputer) {
        updaterRuntime?.service.suppressAutoInstall()
        dialog.showErrorBox("电脑操作已停止", "无法确认自动键鼠已释放。请检查键鼠状态后再打开 Desktop。")
      }
      if (!isDataRootMigrationShutdown()) await flushDesktopBusinessData()
      await desktopNoteService.close()
      await getDesktopPluginAppService()?.dispose()
      desktopPluginAppDocuments.clear()
      updaterRuntime?.service.dispose()
      updaterRuntime = null
      await Promise.all([desktopTerminalService.dispose(), desktopSessionService.dispose()])
      ipcRegistry?.dispose()
      destroyTray()
      shutdownComplete = true
      setForceQuit(true)
      app.quit()
    })().catch(() => {
      setForceQuit(false)
      ctx?.windowManager.getMain()?.show()
      dialog.showErrorBox("未能退出", "业务草稿未能保存。请保留当前窗口，重试保存后再退出。")
    }).finally(() => { shutdown = null })
  })
}

function requireContext(): AppContext {
  if (!ctx) throw new Error("AppContext is not initialized")
  return ctx
}
