import { beforeEach, describe, expect, it, vi } from "vitest"

const { show, noteUnfocusedAttention } = vi.hoisted(() => ({
  show: vi.fn(),
  noteUnfocusedAttention: vi.fn(),
}))

vi.mock("electron", () => ({
  app: { getName: vi.fn(() => "Vykor") },
  BrowserWindow: {},
  Menu: {},
  nativeImage: {},
  Notification: class {
    static isSupported = vi.fn(() => true)
    constructor(readonly options: unknown) {}
    show = show
  },
  Tray: class {},
}))

vi.mock("./attention-badge", () => ({
  noteUnfocusedAttention,
}))

import { sendTrayNotification } from "./tray"

describe("sendTrayNotification", () => {
  beforeEach(() => {
    show.mockClear()
    noteUnfocusedAttention.mockClear()
  })

  it("increments attention when a notification arrives while the main window is unfocused", () => {
    const getMainWindow = (): { isFocused(): boolean } => ({
      isFocused: () => false,
    })

    sendTrayNotification({ title: "Vykor", body: "任务已完成。" }, getMainWindow as never)

    expect(noteUnfocusedAttention).toHaveBeenCalledWith(getMainWindow)
    expect(show).toHaveBeenCalledOnce()
  })

  it("does not increment attention while the main window is focused", () => {
    sendTrayNotification(
      {
        title: "Vykor",
        body: "任务已完成。",
        showWhenFocused: true,
      },
      (() => ({ isFocused: () => true })) as never
    )

    expect(noteUnfocusedAttention).not.toHaveBeenCalled()
    expect(show).toHaveBeenCalledOnce()
  })
})
