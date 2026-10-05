import { beforeEach, expect, it, vi } from "vitest"

const runtime = vi.hoisted(() => ({
  clearCache: vi.fn<() => Promise<void>>(),
  loadURL: vi.fn(async () => {}),
  loadFile: vi.fn(async () => {}),
}))

vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = { session: { clearCache: runtime.clearCache } }
    loadURL = runtime.loadURL
    loadFile = runtime.loadFile
    on = vi.fn()
    isDestroyed = () => false
  },
}))

import { WindowManager } from "./window-manager"

const paths = {
  mainDirname: "/app/main",
  indexHtml: "/app/renderer/index.html",
  preloadPath: "/app/preload/index.js",
  iconPath: "/app/icon.png",
}

beforeEach(() => {
  vi.clearAllMocks()
  runtime.clearCache.mockResolvedValue(undefined)
})

it("waits for stale HTTP dependencies to be cleared before loading the development renderer", async () => {
  let finish!: () => void
  runtime.clearCache.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  new WindowManager().createWindow({
    id: "main",
    route: "/",
    options: {},
    paths: { ...paths, rendererUrl: "http://localhost:5173/" },
  })

  expect(runtime.loadURL).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => expect(runtime.loadURL).toHaveBeenCalledWith("http://localhost:5173/#/"))
})

it("loads packaged HTML without clearing its session cache", () => {
  new WindowManager().createWindow({ id: "main", route: "/", paths, options: {} })
  expect(runtime.loadFile).toHaveBeenCalledWith("/app/renderer/index.html", { hash: "/" })
  expect(runtime.clearCache).not.toHaveBeenCalled()
})
