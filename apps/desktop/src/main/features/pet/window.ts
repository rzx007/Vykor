import { BrowserWindow, screen } from "electron"

import { IpcEvents, type PetState } from "../../../shared/ipc-channels"

import type { AppContext } from "../../core/app-context"

import { getPetPreferences, patchPetPreferences } from "./pet-preferences"

const WM_NCLBUTTONDOWN = 0x00a1
const WM_NCLBUTTONUP = 0x00a2
const WM_NCLBUTTONDBLCLK = 0x00a3
const clickMoveTolerancePx = 4
const singleClickDelayMs = 280

const PET_WIDTH = 120

const PET_HEIGHT = 120

const PET_MARGIN = 28

const TRANSPARENT_BACKGROUND = "#00000000"

export function createPetWindow(ctx: AppContext): BrowserWindow {
  const existing = ctx.windowManager.get("pet")

  if (existing) return existing

  const preferences = getPetPreferences()

  const win = ctx.windowManager.createWindow({
    id: "pet",
    route: "/pet",
    paths: ctx.paths,
    options: {
      width: PET_WIDTH,
      height: PET_HEIGHT,
      title: "Vykor Pet",
      frame: false,
      transparent: true,
      backgroundColor: TRANSPARENT_BACKGROUND,
      alwaysOnTop: preferences.alwaysOnTop,
      resizable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      hasShadow: false,
    },

    onCreated: (petWindow) => {
      petWindow.setBackgroundColor(TRANSPARENT_BACKGROUND)

      petWindow.setIgnoreMouseEvents(preferences.ignoreMouseEvents, { forward: true })

      petWindow.on("moved", () => persistPetPosition(petWindow))

      petWindow.on("closed", () => persistPetPosition(petWindow))

      attachPetPointerActions(ctx, petWindow)
    },
  })

  win.hide()

  return win
}

export function showPetWindow(ctx: AppContext): void {
  const win = ctx.windowManager.get("pet") ?? createPetWindow(ctx)

  const preferences = getPetPreferences()

  const position = clampPetPosition(preferences.position ?? getDefaultPetPosition())

  win.setBounds({ ...position, width: PET_WIDTH, height: PET_HEIGHT }, false)

  win.setAlwaysOnTop(preferences.alwaysOnTop)

  win.setIgnoreMouseEvents(preferences.ignoreMouseEvents, { forward: true })

  win.show()
}

export function hidePetWindow(ctx: AppContext): void {
  ctx.windowManager.get("pet")?.hide()
}

export function togglePetWindow(ctx: AppContext): PetState {
  const win = ctx.windowManager.get("pet") ?? createPetWindow(ctx)

  if (win.isVisible()) {
    win.hide()
  } else {
    showPetWindow(ctx)
  }

  return getPetState(ctx)
}

export function setPetAlwaysOnTop(ctx: AppContext, value: boolean): PetState {
  patchPetPreferences({ alwaysOnTop: value })

  const win = ctx.windowManager.get("pet")

  win?.setAlwaysOnTop(value)

  return getPetState(ctx)
}

export function setPetIgnoreMouseEvents(ctx: AppContext, value: boolean): PetState {
  patchPetPreferences({ ignoreMouseEvents: value })

  const win = ctx.windowManager.get("pet")

  win?.setIgnoreMouseEvents(value, { forward: true })

  return getPetState(ctx)
}

export function getPetState(ctx: AppContext): PetState {
  const win = ctx.windowManager.get("pet")

  const preferences = getPetPreferences()

  const bounds = win && !win.isDestroyed() ? win.getBounds() : null

  return {
    visible: Boolean(win?.isVisible()),

    alwaysOnTop: preferences.alwaysOnTop,

    ignoreMouseEvents: preferences.ignoreMouseEvents,

    position: bounds ? { x: bounds.x, y: bounds.y } : preferences.position,
  }
}

function attachPetPointerActions(ctx: AppContext, petWindow: BrowserWindow): void {
  let downPosition: { x: number; y: number } | null = null
  let clickTimer: ReturnType<typeof setTimeout> | null = null

  const cancelPendingClick = (): void => {
    if (!clickTimer) return
    clearTimeout(clickTimer)
    clickTimer = null
  }

  const emitClicked = (): void => {
    if (petWindow.isDestroyed()) return
    petWindow.webContents.send(IpcEvents.petClicked)
  }

  if (process.platform === "win32") {
    petWindow.hookWindowMessage(WM_NCLBUTTONDOWN, () => {
      const bounds = petWindow.getBounds()
      downPosition = { x: bounds.x, y: bounds.y }
    })

    petWindow.hookWindowMessage(WM_NCLBUTTONUP, () => {
      if (!downPosition) return
      const bounds = petWindow.getBounds()
      const moved =
        Math.abs(bounds.x - downPosition.x) > clickMoveTolerancePx ||
        Math.abs(bounds.y - downPosition.y) > clickMoveTolerancePx
      downPosition = null
      if (moved) return

      cancelPendingClick()
      clickTimer = setTimeout(() => {
        clickTimer = null
        emitClicked()
      }, singleClickDelayMs)
    })

    petWindow.hookWindowMessage(WM_NCLBUTTONDBLCLK, () => {
      cancelPendingClick()
      openMainWindow(ctx)
    })
  }

  petWindow.on("maximize", () => {
    cancelPendingClick()
    if (petWindow.isMaximized()) petWindow.unmaximize()
    openMainWindow(ctx)
  })

  petWindow.on("closed", () => cancelPendingClick())
}

function openMainWindow(ctx: AppContext): void {
  ctx.createMainWindow()
}

export function syncPetWithMainWindow(ctx: AppContext, mainWindow: BrowserWindow): void {
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    hidePetWindow(ctx)
  }
}

function persistPetPosition(win: BrowserWindow): void {
  if (win.isDestroyed()) return

  const bounds = win.getBounds()

  patchPetPreferences({ position: { x: bounds.x, y: bounds.y } })
}

function getDefaultPetPosition(): { x: number; y: number } {
  const display = screen.getPrimaryDisplay()

  return {
    x: display.workArea.x + display.workArea.width - PET_WIDTH - PET_MARGIN,

    y: display.workArea.y + display.workArea.height - PET_HEIGHT - PET_MARGIN,
  }
}

function clampPetPosition(position: { x: number; y: number }): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint(position)

  const minX = display.workArea.x

  const minY = display.workArea.y

  const maxX = display.workArea.x + display.workArea.width - PET_WIDTH

  const maxY = display.workArea.y + display.workArea.height - PET_HEIGHT

  return {
    x: Math.min(Math.max(position.x, minX), maxX),

    y: Math.min(Math.max(position.y, minY), maxY),
  }
}
