import { app, BrowserWindow, dialog, ipcMain } from "electron"
import { join } from "node:path"
import { acquireDataRootWriter, dataRootHome, getDataRoot } from "@vykor/host-config/paths"
import { prepareLegacyDesktopSessionLookup } from "@vykor/server/daemon-host"
import { createBusinessDataIpcContribution } from "./features/business-data/ipc"
import { flushDesktopBusinessData, trackBusinessDataWindow } from "./features/business-data/window-flush"
import { setDesktopRootWriter } from "./core/ipc/operation-gate"
import { wrapIpcHandler } from "./core/ipc/wrap-handler"
import { dataRootSettingsIpcContribution } from "./features/settings/data-root-settings-ipc"
import { desktopDataRootRequest, isDataRootMigrationShutdown, setDataRootMaintenanceMode } from "./features/settings/data-root-settings-service"
import { MaintenanceSettingsChannels } from "../shared/maintenance-settings-types"

/** A bounded business export window: no normal application, daemon launcher, budgets or auto-start. */
export async function startDataRootMaintenance(): Promise<void> {
  setDataRootMaintenanceMode()
  await app.whenReady()
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  const prepared = await prepareLegacyDesktopSessionLookup(desktopDataRootRequest(getDataRoot()))
  setDesktopRootWriter(await acquireDataRootWriter({ homeDir: dataRootHome(), dataRoot: getDataRoot(), kind: "desktop" }))
  for (const contribution of [createBusinessDataIpcContribution(prepared.lookup, prepared.legacySources), dataRootSettingsIpcContribution])
    for (const { channel, handler } of contribution.register(undefined as never)) ipcMain.handle(channel, wrapIpcHandler(contribution.id, channel, handler))
  ipcMain.handle(MaintenanceSettingsChannels.chooseDirectory, wrapIpcHandler("data-root-settings", MaintenanceSettingsChannels.chooseDirectory, async () => {
    const choice = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })
    return choice.canceled ? null : choice.filePaths[0] ?? null
  }))
  const window = new BrowserWindow({ width: 940, height: 760, title: "Vykor 用户数据根维护", autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, "../preload/index.js"), contextIsolation: true, sandbox: false, additionalArguments: ["--data-root-maintenance"] } })
  trackBusinessDataWindow(window.webContents)
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", event => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await window.loadFile(join(__dirname, "../renderer/index.html"))
  let complete = false, closing = false
  app.on("before-quit", event => {
    if (complete) return
    event.preventDefault()
    if (closing) return
    closing = true
    void (async () => {
      if (!isDataRootMigrationShutdown()) await flushDesktopBusinessData()
      complete = true; app.quit()
    })().catch(() => { closing = false; dialog.showErrorBox("业务数据未保存", "请保留维护窗口并重试导出。") })
  })
  window.on("close", event => { if (!complete) { event.preventDefault(); app.quit() } })
}
