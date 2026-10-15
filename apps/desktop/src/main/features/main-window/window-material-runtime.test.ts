import { EventEmitter } from "node:events"
import type { BrowserWindow } from "electron"
import { describe, expect, it, vi } from "vitest"
import type { DesktopWindowMaterialState } from "../../../shared/window-material-types"
import { attachWindowMaterialRuntime } from "./window-material-runtime"

describe("window material runtime", () => {
  it("系统/GPU变化后应用权威状态，页面重载后重发，关窗清理监听", () => {
    const nativeTheme = new EventEmitter(),
      app = new EventEmitter()
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false }),
    })
    let requested: DesktopWindowMaterialState = {
      preference: "glass",
      active: "glass",
      shell: "transparent",
      unavailableReason: null,
    }
    const apply = vi.fn((state: DesktopWindowMaterialState) => state),
      notify = vi.fn()
    const runtime = attachWindowMaterialRuntime(win as unknown as BrowserWindow, {
      nativeTheme,
      app,
      resolve: () => requested,
      apply,
      notify,
    })
    expect(runtime.getState()).toEqual(requested)
    requested = {
      ...requested,
      active: "opaque",
      shell: "solid",
      unavailableReason: "unsupported-system",
    }
    app.emit("gpu-info-update")
    expect(runtime.getState()).toEqual(requested)
    expect(notify).toHaveBeenLastCalledWith(requested)
    win.webContents.emit("did-finish-load")
    expect(notify).toHaveBeenCalledTimes(3)
    requested = { ...requested, active: "glass", shell: "transparent", unavailableReason: null }
    nativeTheme.emit("updated")
    expect(runtime.getState()).toEqual(requested)
    win.emit("closed")
    expect(nativeTheme.listenerCount("updated")).toBe(0)
    expect(app.listenerCount("gpu-info-update")).toBe(0)
    expect(win.webContents.listenerCount("did-finish-load")).toBe(0)
  })
  it("材质应用失败后的实色状态为读取和通知的结果", () => {
    const requested: DesktopWindowMaterialState = {
      preference: "glass",
      active: "glass",
      shell: "transparent",
      unavailableReason: null,
    }
    const actual: DesktopWindowMaterialState = {
      ...requested,
      active: "opaque",
      shell: "solid",
      unavailableReason: "material-error",
    }
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false }),
    })
    const notify = vi.fn()
    const runtime = attachWindowMaterialRuntime(win as unknown as BrowserWindow, {
      nativeTheme: new EventEmitter(),
      app: new EventEmitter(),
      resolve: () => requested,
      apply: () => actual,
      notify,
    })
    expect(runtime.getState()).toEqual(actual)
    expect(notify).toHaveBeenLastCalledWith(actual)
  })

  it("窗口销毁后清理监听不再访问已销毁的 webContents", () => {
    const nativeTheme = new EventEmitter()
    const app = new EventEmitter()
    const webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false })
    let destroyed = false
    const win = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed })
    Object.defineProperty(win, "webContents", {
      get() {
        if (destroyed) throw new Error("Object has been destroyed")
        return webContents
      },
    })

    attachWindowMaterialRuntime(win as unknown as BrowserWindow, {
      nativeTheme,
      app,
      resolve: () => ({
        preference: "opaque",
        active: "opaque",
        shell: "solid",
        unavailableReason: null,
      }),
      apply: (state) => state,
      notify: vi.fn(),
    })

    destroyed = true
    expect(() => win.emit("closed")).not.toThrow()
    expect(webContents.listenerCount("did-finish-load")).toBe(0)
  })
})
