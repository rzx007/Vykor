import type { IpcMainInvokeEvent } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { IpcChannels } from "../../../shared/ipc-channels"
import type { AppContext } from "../../core/app-context"
import { windowControlsIpcContribution } from "./ipc"

const mocks = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
  setThemeSource: vi.fn(),
}))
vi.mock("electron", () => ({
  app: { on: vi.fn() },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  shell: {},
}))
vi.mock("../../core/services/lifecycle", () => ({ quitApp: vi.fn(), setForceQuit: vi.fn() }))
vi.mock("../main-window/window", () => ({
  currentMainWindowMaterialState: vi.fn(),
  setMainWindowMaterial: vi.fn(),
  setMainWindowThemeSource: mocks.setThemeSource,
  showMainWindow: vi.fn(),
}))

describe("native window theme IPC", () => {
  const mainWindow = {}
  const event = { sender: {} } as IpcMainInvokeEvent
  const ctx = { windowManager: { getMain: () => mainWindow } } as unknown as AppContext
  const handler = windowControlsIpcContribution
    .register(ctx)
    .find(({ channel }) => channel === IpcChannels.windowSetThemeSource)!.handler
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fromWebContents.mockReturnValue(mainWindow)
  })
  it.each(["light", "dark", "system"])("applies %s from the main window", (source) => {
    handler(event, source)
    expect(mocks.setThemeSource).toHaveBeenCalledWith(mainWindow, source)
  })
  it("rejects an invalid theme", () => {
    expect(() => handler(event, "invalid")).toThrow("未知的窗口主题")
    expect(mocks.setThemeSource).not.toHaveBeenCalled()
  })
  it.each([null, {}])("ignores a sender that is not the main window", (otherWindow) => {
    mocks.fromWebContents.mockReturnValue(otherWindow)
    handler(event, "dark")
    expect(mocks.setThemeSource).not.toHaveBeenCalled()
  })
})
