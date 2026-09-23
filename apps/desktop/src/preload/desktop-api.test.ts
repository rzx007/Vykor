import { describe, expect, it, vi } from "vitest"

const electron = vi.hoisted(() => ({
  invoke: vi.fn(async () => []),
  on: vi.fn(),
  removeListener: vi.fn(),
  getPathForFile: vi.fn((file: { name: string }) =>
    file.name === "missing.png" ? "" : `C:\\drop\\${file.name}`
  ),
}))

vi.mock("electron", () => ({
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
  webUtils: { getPathForFile: electron.getPathForFile },
}))

import { IpcChannels, IpcEvents } from "../shared/ipc-channels"
import { desktopAPI } from "./desktop-api"

describe("desktop activity preload bridge", () => {
  it("opens the global activity stream", async () => {
    await desktopAPI.activity.open()
    expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.activityOpen)
  })

  it("delivers updates and removes the same wrapped listener", () => {
    const listener = vi.fn()
    const unsubscribe = desktopAPI.activity.onUpdated(listener)
    const [, wrapped] = electron.on.mock.lastCall!
    expect(electron.on).toHaveBeenCalledWith(IpcEvents.activityUpdated, wrapped)

    const update = { cursor: 4, delivery: "live", sessions: [], scheduled: [] }
    wrapped({}, update)
    expect(listener).toHaveBeenCalledWith(update)
    unsubscribe()
    expect(electron.removeListener).toHaveBeenCalledWith(IpcEvents.activityUpdated, wrapped)
  })
})

describe("desktop attachment preload bridge", () => {
  it("turns dropped File objects into paths inside preload and does not expose those paths back", async () => {
    const files = [{ name: "report.pdf" }, { name: "missing.png" }] as unknown as File[]

    await desktopAPI.attachments.stageDroppedFiles(files)

    expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.attachmentStageDropped, [
      "C:\\drop\\report.pdf",
    ])
  })

  it("subscribes and unsubscribes the narrow upload event", () => {
    const listener = vi.fn()
    const unsubscribe = desktopAPI.attachments.onUploadEvent(listener)

    expect(electron.on).toHaveBeenCalledWith(IpcEvents.attachmentUploadEvent, expect.any(Function))
    unsubscribe()
    expect(electron.removeListener).toHaveBeenCalledWith(
      IpcEvents.attachmentUploadEvent,
      expect.any(Function)
    )
  })
})

describe("desktop window preload bridge", () => {
  it("opens an address in the system browser through the window IPC channel", async () => {
    await desktopAPI.window.openExternal("file:///D:/demo/index.html")

    expect(electron.invoke).toHaveBeenCalledWith(
      IpcChannels.windowOpenExternal,
      "file:///D:/demo/index.html"
    )
  })

  it("exposes the argv material snapshot and routes the material commands", async () => {
    // vitest 进程的 argv 不含主进程注入的四个前缀参数，因此快照必须是 null（宠物窗口走同一条路径）。
    expect(desktopAPI.window.material).toBeNull()

    await desktopAPI.window.getMaterial()
    await desktopAPI.window.setMaterial("opaque")

    expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.windowGetMaterial)
    expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.windowSetMaterial, "opaque")
  })
})

describe("desktop updater preload bridge", () => {
  it("exposes narrow update commands through their IPC channels", async () => {
    await desktopAPI.updates.getState()
    await desktopAPI.updates.download()
    await desktopAPI.updates.install()

    expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.updateGetState)
    expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.updateDownload)
    expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.updateInstall)
  })

  it("subscribes and unsubscribes the narrow update state event", () => {
    const listener = vi.fn()
    const unsubscribe = desktopAPI.updates.onStateChanged(listener)

    expect(electron.on).toHaveBeenCalledWith(IpcEvents.updateStateChanged, expect.any(Function))
    unsubscribe()
    expect(electron.removeListener).toHaveBeenCalledWith(
      IpcEvents.updateStateChanged,
      expect.any(Function)
    )
  })
})

describe("desktop daemon autostart preload bridge", () => {
  it("exposes only fixed daemon autostart operations", async () => {
    await desktopAPI.daemonAutoStart.snapshot()
    await desktopAPI.daemonAutoStart.enable()
    await desktopAPI.daemonAutoStart.disable()
    await desktopAPI.daemonAutoStart.dismissOnboarding()

    expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.daemonAutoStartSnapshot)
    expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.daemonAutoStartEnable)
    expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.daemonAutoStartDisable)
    expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.daemonAutoStartDismissOnboarding)
  })
})
