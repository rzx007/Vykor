import type { EventEmitter } from "node:events"
import type { BrowserWindow } from "electron"
import type { DesktopWindowMaterialState } from "../../../shared/window-material-types"

/** 记录实际应用结果；系统变化和页面重载都通过同一条通知更新前端。 */
export function attachWindowMaterialRuntime(
  win: BrowserWindow,
  deps: {
    app: Pick<EventEmitter, "on" | "removeListener">
    nativeTheme: Pick<EventEmitter, "on" | "removeListener">
    resolve: () => DesktopWindowMaterialState
    apply: (state: DesktopWindowMaterialState) => DesktopWindowMaterialState
    notify: (state: DesktopWindowMaterialState) => void
  }
): { getState: () => DesktopWindowMaterialState; refresh: () => DesktopWindowMaterialState } {
  // BrowserWindow.webContents throws after the window emits `closed`. Keep the
  // already-created WebContents reference for both event wiring and cleanup.
  const webContents = win.webContents
  let state = deps.apply(deps.resolve())
  const notify = (): void => {
    if (!win.isDestroyed() && !webContents.isDestroyed()) deps.notify(state)
  }
  const refresh = (): DesktopWindowMaterialState => {
    if (!win.isDestroyed()) {
      state = deps.apply(deps.resolve())
      notify()
    }
    return state
  }
  deps.nativeTheme.on("updated", refresh)
  deps.app.on("gpu-info-update", refresh)
  webContents.on("did-finish-load", notify)
  win.once("closed", () => {
    deps.nativeTheme.removeListener("updated", refresh)
    deps.app.removeListener("gpu-info-update", refresh)
    webContents.removeListener("did-finish-load", notify)
  })
  notify()
  return { getState: () => state, refresh }
}
