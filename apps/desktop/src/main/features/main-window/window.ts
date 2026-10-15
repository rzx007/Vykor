import { app, BrowserWindow, nativeTheme, shell, type WebPreferences } from "electron"
import { release } from "node:os"
import { join } from "node:path"
import { createWindowThemeController } from "./window-theme"
import type { DesktopWindowThemeSource } from "../../../shared/window-theme-types"

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
  supportsWindowsMica,
} from "./window-material"
import { attachWindowMaterialRuntime } from "./window-material-runtime"
import { attachWindowsMaterialRepaint } from "./window-material-repaint"
import { desktopPluginUiDocuments } from "../plugin-ui/document-runtime"
import {
  attachPluginUiWindowPolicy,
  isPluginUiExternalOpenBlocked,
} from "../plugin-ui/window-policy"
import { getDesktopPluginUiService } from "../plugin-ui/service-runtime"
import { pathToFileURL } from "node:url"
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

const materialRuntimes = new WeakMap<
  BrowserWindow,
  ReturnType<typeof attachWindowMaterialRuntime>
>()

let themeController: ReturnType<typeof createWindowThemeController> | undefined
function getThemeController(): ReturnType<typeof createWindowThemeController> {
  return (themeController ??= createWindowThemeController({
    platform: process.platform,
    nativeTheme,
    preferencePath: join(app.getPath("userData"), "desktop-window-theme.json"),
  }))
}

export function setMainWindowThemeSource(
  win: BrowserWindow,
  source: DesktopWindowThemeSource
): void {
  if (process.platform !== "win32") return
  getThemeController().set(source)
  materialRuntimes.get(win)?.refresh()
}

export function createMainWindow(ctx: AppContext): BrowserWindow {
  const existing = ctx.windowManager.getMain()
  if (existing) {
    showMainWindow(existing)
    return existing
  }

  const platform = process.platform
  if (platform === "win32") getThemeController()
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
      title: "Vykor",
      autoHideMenuBar: true,
      ...mainWindowChromeOptions(platform),
      ...mainWindowMaterialOptions({
        platform,
        state: materialState,
        useDarkColors: nativeTheme.shouldUseDarkColors,
      }),
      webPreferences: {
        webviewTag: true,
        autoplayPolicy: "no-user-gesture-required",
        // renderer 首帧就要知道玻璃是否真的生效，才能一次性画出正确的外壳底色。
        // 走 additionalArguments 而不是 IPC：IPC 只能异步，会在玻璃与不透明之间闪一帧。
        additionalArguments: windowMaterialArguments(materialState),
      },
    },
    onCreated: (win) => {
      getDesktopPluginUiService()?.registerOwner(
        win.webContents,
        ctx.paths.rendererUrl ?? pathToFileURL(ctx.paths.indexHtml).href
      )
      attachPluginUiWindowPolicy(win.webContents, desktopPluginUiDocuments)
      attachMainWindowBehavior(ctx, win)
      attachMainWindowDiagnostics(win)
      const runtime = attachWindowMaterialRuntime(win, {
        app,
        nativeTheme,
        resolve: () => currentMainWindowMaterialState(platform),
        apply: (state) =>
          applyMainWindowMaterial(win, {
            platform,
            state,
            useDarkColors: nativeTheme.shouldUseDarkColors,
          }),
        notify: (state) => win.webContents.send(IpcEvents.windowMaterialChanged, state),
      })
      materialRuntimes.set(win, runtime)
      // Windows 系统材质在拉伸与托盘 hide→show 后可能留下合成层死区。
      if (platform === "win32") attachWindowsMaterialRepaint(win)
    },
  })

  return mainWindow
}

/**
 * 当前材质状态。刻意保持同步：建窗口路径（托盘、activate、second-instance 都会走到）不能 await。
 * Windows 原生主题在建窗前及应用切换主题时单独同步；状态查询不改主题。
 * macOS vibrancy 继续跟随系统，不覆盖其 nativeTheme.themeSource。
 */
export function currentMainWindowMaterialState(
  platform: NodeJS.Platform = process.platform,
  win?: BrowserWindow | null
): DesktopWindowMaterialState {
  const runtime = win ? materialRuntimes.get(win) : undefined
  if (runtime) return runtime.getState()
  let nativeBackdropSupported = true
  if (platform === "win32") {
    // 新版 Electron 可直接查询；本项目 Electron 39 走 Windows 11 22H2 + GPU 检测。
    const backdropApi = BrowserWindow as typeof BrowserWindow & {
      isSystemBackdropSupported?: () => boolean
    }
    try {
      nativeBackdropSupported = supportsWindowsMica({
        release: release(),
        gpuCompositing: app.getGPUFeatureStatus().gpu_compositing,
        systemBackdropSupported: backdropApi.isSystemBackdropSupported?.(),
      })
    } catch {
      nativeBackdropSupported = false
    }
  }
  return resolveWindowMaterialState({
    platform,
    preference: getWindowMaterialPreference(),
    reducedTransparency:
      nativeTheme.prefersReducedTransparency ||
      (platform === "win32" && nativeTheme.shouldUseHighContrastColors),
    nativeBackdropSupported,
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

  const runtime = materialRuntimes.get(win)
  if (runtime) return runtime.refresh()

  const state = currentMainWindowMaterialState(process.platform)
  return applyMainWindowMaterial(win, {
    platform: process.platform,
    state,
    useDarkColors: nativeTheme.shouldUseDarkColors,
  })
}

export function showMainWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function attachMainWindowBehavior(ctx: AppContext, win: BrowserWindow): void {
  attachWebviewPolicy(win)
  browserAgentService.setOpenTabRequestHandler(() => {
    showMainWindow(win)
    win.webContents.send(IpcEvents.browserOpenRequest)
  })
  win.once("closed", () => browserAgentService.setOpenTabRequestHandler(undefined))
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

  win.webContents.setWindowOpenHandler(({ url, referrer }) => {
    if (isPluginUiExternalOpenBlocked(referrer.url)) return { action: "deny" }
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
    params.partition = "persist:vykor-browser"
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
