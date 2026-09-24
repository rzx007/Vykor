import { beforeEach, describe, expect, it, vi } from "vitest"
import type { IpcMainInvokeEvent } from "electron"

const electron = vi.hoisted(() => ({
  on: vi.fn(),
  fromWebContents: vi.fn(),
  openExternal: vi.fn(),
  openPath: vi.fn(),
}))

vi.mock("electron", () => ({
  app: {
    on: electron.on,
    getName: vi.fn(() => "Vykor"),
    getVersion: vi.fn(() => "1.0.0"),
    isPackaged: false,
  },
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  shell: { openExternal: electron.openExternal, openPath: electron.openPath },
}))

const windowModule = vi.hoisted(() => ({
  currentMainWindowMaterialState: vi.fn(),
  setMainWindowMaterial: vi.fn(),
  showMainWindow: vi.fn(),
}))

vi.mock("../main-window/window", () => windowModule)

import { IpcChannels } from "../../../shared/ipc-channels"
import type { DesktopWindowMaterialState } from "../../../shared/window-material-types"
import { windowControlsIpcContribution } from "./ipc"

function windowSetMaterialHandler() {
  const registration = windowControlsIpcContribution
    .register({} as never)
    .find((entry) => entry.channel === IpcChannels.windowSetMaterial)!
  return registration.handler
}

function windowGetMaterialHandler() {
  const registration = windowControlsIpcContribution
    .register({} as never)
    .find((entry) => entry.channel === IpcChannels.windowGetMaterial)!
  return registration.handler
}

const event = { sender: {} } as unknown as IpcMainInvokeEvent

describe("window material IPC handler", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("rejects an unknown material preference before touching the window", () => {
    expect(() => windowSetMaterialHandler()(event, "holographic")).toThrow("未知的窗口材质设置。")

    expect(electron.fromWebContents).not.toHaveBeenCalled()
    expect(windowModule.setMainWindowMaterial).not.toHaveBeenCalled()
  })

  it("fails when the sender is not attached to a BrowserWindow", () => {
    electron.fromWebContents.mockReturnValue(null)

    expect(() => windowSetMaterialHandler()(event, "opaque")).toThrow(
      "窗口不存在，无法切换窗口材质。"
    )

    expect(windowModule.setMainWindowMaterial).not.toHaveBeenCalled()
  })

  it("returns the authoritative state from the window module unchanged", () => {
    const win = { id: 7 }
    const state: DesktopWindowMaterialState = {
      preference: "opaque",
      active: "opaque",
      unavailableReason: null,
      shell: "solid",
    }
    electron.fromWebContents.mockReturnValue(win)
    windowModule.setMainWindowMaterial.mockReturnValue(state)

    const result = windowSetMaterialHandler()(event, "opaque")

    expect(electron.fromWebContents).toHaveBeenCalledWith(event.sender)
    expect(windowModule.setMainWindowMaterial).toHaveBeenCalledWith(win, "opaque")
    expect(result).toBe(state)
  })

  it("returns the current material state for renderer reconciliation", () => {
    const state: DesktopWindowMaterialState = {
      preference: "glass",
      active: "glass",
      unavailableReason: null,
      shell: "transparent",
    }
    windowModule.currentMainWindowMaterialState.mockReturnValue(state)

    const result = windowGetMaterialHandler()(event)

    expect(windowModule.currentMainWindowMaterialState).toHaveBeenCalledTimes(1)
    expect(result).toBe(state)
  })
})
