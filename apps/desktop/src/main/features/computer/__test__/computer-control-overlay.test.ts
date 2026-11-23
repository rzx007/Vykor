import { beforeEach, expect, it, vi } from "vitest"

const electron = vi.hoisted(() => {
  const windows: { destroy: ReturnType<typeof vi.fn>; showInactive: ReturnType<typeof vi.fn>; listeners: Map<string, () => void> }[] = []
  const loadURL = vi.fn<() => Promise<void>>()
  const BrowserWindow = vi.fn(function () {
    const listeners = new Map<string, () => void>()
    const window = {
      setIgnoreMouseEvents: vi.fn(), setContentProtection: vi.fn(), loadURL,
      showInactive: vi.fn(), isDestroyed: () => false, isVisible: () => true, destroy: vi.fn(),
      once: (event: string, fn: () => void) => listeners.set(event, fn), listeners, webContents: { once: vi.fn() },
    }
    windows.push(window)
    return window
  })
  return { BrowserWindow, screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] }, windows, loadURL }
})

vi.mock("electron", () => electron)

import { showComputerControlOverlay } from "../computer-control-overlay"

beforeEach(() => {
  electron.BrowserWindow.mockClear()
  electron.windows.length = 0
  electron.loadURL.mockReset().mockResolvedValue(undefined)
})

it("never shows or focuses a pending overlay after the foreground lease ends", async () => {
  const unavailable = vi.fn()
  const scope = new AbortController()
  const pending = showComputerControlOverlay(scope.signal, unavailable)
  expect(electron.BrowserWindow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    show: false, focusable: false, transparent: true, alwaysOnTop: true, width: 1920, height: 1080,
  }))
  scope.abort()
  electron.windows[0]?.listeners.get("ready-to-show")?.()
  await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  expect(electron.windows[0]?.destroy).toHaveBeenCalledOnce()
  expect(electron.windows[0]?.showInactive).not.toHaveBeenCalled()
  expect(unavailable).not.toHaveBeenCalled()
})

it("rejects foreground startup when the overlay cannot open", async () => {
  electron.BrowserWindow.mockImplementationOnce(() => { throw new Error("Display lost") })
  await expect(showComputerControlOverlay(new AbortController().signal, vi.fn())).rejects.toThrow("无法显示前台控制提示")
})

it("waits for the first paint and reports a visible overlay that closes unexpectedly", async () => {
  const unavailable = vi.fn()
  const pending = showComputerControlOverlay(new AbortController().signal, unavailable)
  const overlay = electron.windows[0]!
  await Promise.resolve()
  expect(overlay.showInactive).not.toHaveBeenCalled()
  overlay.listeners.get("ready-to-show")?.()
  await pending
  expect(overlay.showInactive).toHaveBeenCalledOnce()
  overlay.listeners.get("closed")?.()
  expect(unavailable).toHaveBeenCalledOnce()
})
