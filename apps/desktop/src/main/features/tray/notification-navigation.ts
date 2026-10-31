import type { BrowserWindow, WebContents } from "electron"
import { IpcEvents } from "../../../shared/ipc-channels"
import { showMainWindow } from "../main-window/window"

const windows = new WeakMap<WebContents, { ready: boolean; pending?: string }>()

function stateFor(contents: WebContents) {
  let state = windows.get(contents)
  if (!state) {
    state = { ready: false }
    windows.set(contents, state)
    const current = state
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) current.ready = false
    })
  }
  return state
}

function flush(contents: WebContents): void {
  const state = windows.get(contents)
  if (!state?.ready || !state.pending || contents.isDestroyed()) return
  contents.send(IpcEvents.trayNotificationClicked, state.pending)
  state.pending = undefined
}

export function openNotificationSession(
  sessionId: string,
  getMainWindow: () => BrowserWindow | null
): void {
  if (!sessionId.trim()) return
  const win = getMainWindow()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  stateFor(win.webContents).pending = sessionId
  showMainWindow(win)
  flush(win.webContents)
}

export function notificationNavigationReady(sender: WebContents): void {
  if (sender.isDestroyed()) return
  stateFor(sender).ready = true
  flush(sender)
}
