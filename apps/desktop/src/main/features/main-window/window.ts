import { BrowserWindow, nativeTheme, shell, type WebPreferences } from "electron"

import { IpcEvents } from "../../../shared/ipc-channels"
import type { AppContext } from "../../core/app-context"
import { isForceQuit } from "../../core/services/lifecycle"
import { showPetWindow, syncPetWithMainWindow } from "../pet/window"
import { clearAttention } from "../tray/attention-badge"
import { isAllowedWebviewUrl } from "./webview-policy"
import { browserAgentService } from "../browser/browser-agent-service"
import { mainWindowChromeOptions } from "./window-chrome"
import {
  applyMainWindowMaterial,
  mainWindowMaterialOptions,
  resolveWindowMaterialState,
} from "./window-material"
import { attachWindowsMaterialRepaint } from "./window-material-repaint"
import {
  getWindowMaterialPreference,
  setWindowMaterialPreference,
} from "./window-material-preference"
import {
  isDesktopWindowMaterialPreference,
  type DesktopWindowMaterialPreference,
  type DesktopWindowMaterialState,
  windowMaterialArguments,
} from "../../../shared/window-material-types"

export function createMainWindow(ctx: AppContext): BrowserWindow {
  const existing = ctx.windowManager.getMain()
  if (existing) {
    showMainWindow(existing)
    return existing
  }

  const platform = process.platform
  const materialState = currentMainWindowMaterialState(platform)

  const mainWindow = ctx.windowManager.createWindow({
    id: "main",
    route: "/",
    paths: ctx.paths,
    options: {
      width: 1180,
      height: 760,
      minWidth: 960,
      minHeight: 640,
      title: "OpenHarness",
      autoHideMenuBar: true,
      ...mainWindowChromeOptions(platform),
      ...mainWindowMaterialOptions({
        platform,
        state: materialState,
        useDarkColors: nativeTheme.shouldUseDarkColors,
      }),
      webPreferences: {
        webviewTag: true,
        // renderer 首帧就要知道玻璃是否真的生效，才能一次性画出正确的外壳底色。
        // 走 additionalArguments 而不是 IPC：IPC 只能异步，会在玻璃与不透明之间闪一帧。
        additionalArguments: windowMaterialArguments(materialState),
      },
    },
    onCreated: (win) => {
      attachMainWindowBehavior(ctx, win)
      attachMainWindowDiagnostics(win)
      // 构造期材质激活有历史 bug（electron/electron#46657、#47386），这里再应用一次做兜底。
      applyMainWindowMaterial(win, {
        platform,
        state: materialState,
        useDarkColors: nativeTheme.shouldUseDarkColors,
      })
      // 仅 Windows 需要：acrylic 窗口在拉伸与托盘 hide→show 后可能留下合成层死区。
      if (platform === "win32") attachWindowsMaterialRepaint(win)
    },
  })

  return mainWindow
}

/**
 * 当前材质状态。刻意保持同步：建窗口路径（托盘、activate、second-instance 都会走到）不能 await。
 * 刻意不写 nativeTheme.themeSource：启动 loading 阶段写原生窗口主题会污染系统壳观察到的窗口主题，
 * 且会让 macOS vibrancy 跟随应用主题而不是系统主题。不要在这里「顺手补齐」。
 */
export function currentMainWindowMaterialState(
  platform: NodeJS.Platform = process.platform
): DesktopWindowMaterialState {
  return resolveWindowMaterialState({
    platform,
    preference: getWindowMaterialPreference(),
    reducedTransparency: nativeTheme.prefersReducedTransparency,
  })
}

/** 供 `window:set-material` 使用：先落盘偏好，再把材质应用到窗口。 */
export function setMainWindowMaterial(
  win: BrowserWindow,
  preference: DesktopWindowMaterialPreference
): DesktopWindowMaterialState {
  if (!isDesktopWindowMaterialPreference(preference)) {
    throw new Error("未知的窗口材质设置。")
  }

  setWindowMaterialPreference(preference)

  const state = currentMainWindowMaterialState(process.platform)
  applyMainWindowMaterial(win, {
    platform: process.platform,
    state,
    useDarkColors: nativeTheme.shouldUseDarkColors,
  })

  return state
}

export function showMainWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function attachMainWindowBehavior(ctx: AppContext, win: BrowserWindow): void {
  attachWebviewPolicy(win)
  const clearUnreadAttention = (): void => clearAttention(() => win)

  win.once("ready-to-show", () => {
    showMainWindow(win)
  })

  win.on("close", (event) => {
    if (isForceQuit()) return

    event.preventDefault()
    win.hide()
    showPetWindow(ctx)
  })

  win.on("minimize", () => {
    showPetWindow(ctx)
  })

  win.on("restore", () => {
    clearUnreadAttention()
    syncPetWithMainWindow(ctx, win)
  })

  win.on("show", () => {
    clearUnreadAttention()
    syncPetWithMainWindow(ctx, win)
  })

  win.on("focus", clearUnreadAttention)

  win.on("maximize", () => {
    win.webContents.send(IpcEvents.windowMaximizedChanged, true)
  })

  win.on("unmaximize", () => {
    win.webContents.send(IpcEvents.windowMaximizedChanged, false)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:") || url.startsWith("http:")) {
      void shell.openExternal(url)
    }

    return { action: "deny" }
  })
}

function attachWebviewPolicy(win: BrowserWindow): void {
  win.webContents.on("did-attach-webview", (_event, guest) => {
    browserAgentService.trackGuest(win.webContents.id, guest)
  })
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!isAllowedWebviewUrl(params.src)) {
      event.preventDefault()
      return
    }

    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.sandbox = true
    ;(webPreferences as WebPreferences & { javascript?: boolean }).javascript = true
    params.partition = "persist:openharness-browser"
  })
}

function attachMainWindowDiagnostics(win: BrowserWindow): void {
  let recoveryCount = 0

  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("[main-window] renderer process gone", {
      reason: details.reason,
      exitCode: details.exitCode,
      url: win.webContents.getURL(),
      recoveryCount,
    })

    if (win.isDestroyed() || recoveryCount >= 2) return
    recoveryCount += 1
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload()
    }, 500).unref()
  })

  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      console.error("[main-window] failed to load", {
        errorCode,
        errorDescription,
        validatedURL,
      })
    }
  )

  win.on("unresponsive", () => {
    console.warn("[main-window] unresponsive")
  })

  win.on("responsive", () => {
    console.info("[main-window] responsive")
  })
}
