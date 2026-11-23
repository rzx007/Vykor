import { expect, it, vi } from "vitest"

const electron = vi.hoisted(() => {
  const windows: { destroy: ReturnType<typeof vi.fn>; showInactive: ReturnType<typeof vi.fn> }[] = []
  const loaded = Promise.withResolvers<void>()
  const BrowserWindow = vi.fn(function () {
    const window = {
      setIgnoreMouseEvents: vi.fn(), setContentProtection: vi.fn(), loadURL: () => loaded.promise,
      showInactive: vi.fn(), isDestroyed: () => false, destroy: vi.fn(),
      once: vi.fn(), webContents: { once: vi.fn() },
    }
    windows.push(window)
    return window
  })
  return { BrowserWindow, screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] }, windows, loaded }
})

vi.mock("electron", () => electron)

import { showComputerControlOverlay } from "../computer-control-overlay"

it("never shows or focuses a pending overlay after the foreground lease ends", async () => {
  const unavailable = vi.fn()
  const close = showComputerControlOverlay(unavailable)
  expect(electron.BrowserWindow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    show: false, focusable: false, transparent: true, alwaysOnTop: true, width: 1920, height: 1080,
  }))
  close()
  electron.loaded.resolve()
  await electron.loaded.promise
  expect(electron.windows[0]?.destroy).toHaveBeenCalledOnce()
  expect(electron.windows[0]?.showInactive).not.toHaveBeenCalled()
  expect(unavailable).not.toHaveBeenCalled()
})

it("reports an unavailable overlay before control can continue silently", async () => {
  electron.BrowserWindow.mockImplementationOnce(() => { throw new Error("Display lost") })
  const unavailable = vi.fn()
  showComputerControlOverlay(unavailable)
  await Promise.resolve()
  expect(unavailable).toHaveBeenCalledOnce()
})
