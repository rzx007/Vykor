import { app, BrowserWindow, Menu, nativeImage, Notification, Tray } from "electron"
import { getDesktopPreferences, patchDesktopPreferences } from "../settings/desktop-preferences"
import { normalizeNotificationEvents } from "../../../shared/notification-settings-types"

import type { AppContext } from "../../core/app-context"
import { quitApp } from "../../core/services/lifecycle"
import { showMainWindow } from "../main-window/window"
import { hidePetWindow, showPetWindow } from "../pet/window"
import { noteUnfocusedAttention } from "./attention-badge"
import { IpcEvents, type TrayNotificationOptions } from "../../../shared/ipc-channels"

let tray: Tray | null = null
let normalIcon: Electron.NativeImage | null = null
let notifyIcon: Electron.NativeImage | null = null
let flashTimer: ReturnType<typeof setInterval> | null = null

export function createTray(ctx: AppContext): void {
  if (tray || shouldSkipTray()) return

  const baseIcon = nativeImage.createFromPath(ctx.paths.iconPath)
  normalIcon = prepareTrayIcon(baseIcon)
  notifyIcon = createNotifyIcon(normalIcon)

  try {
    tray = new Tray(normalIcon)
    tray.setToolTip(app.getName())
    tray.setContextMenu(createTrayMenu(ctx))
    tray.on("double-click", () => showMainFromTray(ctx))
  } catch (error) {
    console.error("[tray] failed to create tray", error)
    tray = null
    normalIcon = null
    notifyIcon = null
  }
}

export function showMainFromTray(ctx: AppContext): void {
  const mainWindow = ctx.windowManager.getMain() ?? ctx.createMainWindow()
  showMainWindow(mainWindow)
  stopFlashTray()
}

export function flashTray(): void {
  if (!tray || !normalIcon || !notifyIcon || flashTimer) return

  let active = false
  flashTimer = setInterval(() => {
    if (!tray || tray.isDestroyed()) {
      stopFlashTray()
      return
    }

    tray.setImage(active ? normalIcon! : notifyIcon!)
    active = !active
  }, 500)
}

export function stopFlashTray(): void {
  if (flashTimer) {
    clearInterval(flashTimer)
    flashTimer = null
  }

  if (tray && normalIcon && !tray.isDestroyed()) {
    tray.setImage(normalIcon)
  }
}

export function sendTrayNotification(
  options: TrayNotificationOptions,
  getMainWindow: () => BrowserWindow | null
): void {
  const preferences = getDesktopPreferences()
  if (options.eventStatus) {
    if (!normalizeNotificationEvents(preferences.notificationEvents)[options.eventStatus] || preferences.notificationMode === "never") return
    if (options.eventId && preferences.notifiedEventIds?.includes(options.eventId)) return
    // ponytail: cap this ledger at 1,000; the persisted activity cursor protects older replays.
    if (options.eventId) patchDesktopPreferences({ notifiedEventIds: [...(preferences.notifiedEventIds ?? []), options.eventId].slice(-1000) })
  }
  const mainWindow = getMainWindow()
  const focusedWindow = BrowserWindow.getFocusedWindow?.()
  const focused = Boolean(
    focusedWindow
      ? !focusedWindow.isDestroyed() && focusedWindow.isVisible() && !focusedWindow.isMinimized()
      : mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused()
  )
  if (!focused) noteUnfocusedAttention(getMainWindow)
  if (focused && !(options.eventStatus ? preferences.notificationMode === "always" : options.showWhenFocused)) return
  if (!Notification.isSupported()) return

  const notification = new Notification({
    title: options.title,
    body: options.eventStatus ? options.eventStatus === "completed" ? "任务已完成。" : options.eventStatus === "failed" ? "任务运行失败。" : "任务正在等待你处理。" : options.body,
    silent: options.silent,
  })
  notification.on("click", () => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    showMainWindow(win)
    if (options.sessionId)
      win.webContents.send(IpcEvents.trayNotificationClicked, options.sessionId)
  })
  notification.show()
}

export function destroyTray(): void {
  stopFlashTray()
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
  normalIcon = null
  notifyIcon = null
}

function createTrayMenu(ctx: AppContext): Electron.Menu {
  return Menu.buildFromTemplate([
    {
      label: "显示主窗口",
      click: () => showMainFromTray(ctx),
    },
    {
      label: "显示桌面宠物",
      click: () => showPetWindow(ctx),
    },
    {
      label: "隐藏桌面宠物",
      click: () => hidePetWindow(ctx),
    },
    { type: "separator" },
    {
      label: "重启应用",
      click: () => {
        app.relaunch({ args: process.argv.slice(1).concat(["--relaunched"]) })
        quitApp()
      },
    },
    {
      label: "退出",
      click: () => quitApp(),
    },
  ])
}

function prepareTrayIcon(image: Electron.NativeImage): Electron.NativeImage {
  if (process.platform !== "darwin") return image

  const resized = image.resize({ width: 18, height: 18 })
  resized.setTemplateImage(true)
  return resized
}

function createNotifyIcon(image: Electron.NativeImage): Electron.NativeImage {
  if (process.platform === "darwin") return image

  const size = 20
  const source = image.resize({ width: size, height: size })
  const canvasSize = size + 4
  const canvas = Buffer.alloc(canvasSize * canvasSize * 4)
  const bitmap = source.toBitmap()

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const src = (y * size + x) * 4
      const dst = ((y + 2) * canvasSize + x + 2) * 4
      canvas[dst] = bitmap[src + 2]
      canvas[dst + 1] = bitmap[src + 1]
      canvas[dst + 2] = bitmap[src]
      canvas[dst + 3] = bitmap[src + 3]
    }
  }

  for (let y = 0; y < 6; y += 1) {
    for (let x = 0; x < 6; x += 1) {
      const dx = canvasSize - 7 + x
      const dy = 1 + y
      const dst = (dy * canvasSize + dx) * 4
      canvas[dst] = 235
      canvas[dst + 1] = 84
      canvas[dst + 2] = 70
      canvas[dst + 3] = 255
    }
  }

  return nativeImage.createFromBuffer(canvas, {
    width: canvasSize,
    height: canvasSize,
  })
}

function shouldSkipTray(): boolean {
  if (process.platform !== "linux") return false

  const gdkBackend = process.env.GDK_BACKEND
  const waylandOnly = gdkBackend?.split(":").includes("wayland") && !gdkBackend.includes("x11")
  const hasWayland =
    process.env.XDG_SESSION_TYPE === "wayland" || Boolean(process.env.WAYLAND_DISPLAY)
  return Boolean(waylandOnly || (hasWayland && !process.env.DISPLAY))
}
