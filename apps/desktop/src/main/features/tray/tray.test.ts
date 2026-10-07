import { beforeEach, describe, expect, it, vi } from "vitest"

const { show, noteUnfocusedAttention, notifications, preferences, getFocusedWindow } = vi.hoisted(() => ({
  show: vi.fn(),
  noteUnfocusedAttention: vi.fn(),
  notifications: [] as { click?: () => void; options?: unknown }[],
  preferences: { notificationMode: "when_unfocused" as "when_unfocused" | "always" | "never", notificationEvents: { completed: true, failed: true, needs_input: true }, notifiedEventIds: [] as string[] },
  getFocusedWindow: vi.fn(() => null as unknown),
}))

vi.mock("../settings/desktop-preferences", () => ({
  getDesktopPreferences: () => preferences,
  patchDesktopPreferences: (patch: unknown) => Object.assign(preferences, patch),
}))

vi.mock("electron", () => ({
  app: { getName: vi.fn(() => "Vykor") },
  BrowserWindow: { getFocusedWindow },
  Menu: {},
  nativeImage: {},
  Notification: class {
    static isSupported = vi.fn(() => true)
    click?: () => void
    constructor(readonly options: unknown) {
      notifications.push(this)
    }
    on(event: string, listener: () => void) {
      if (event === "click") this.click = listener
      return this
    }
    show = show
  },
  Tray: class {},
}))

vi.mock("./attention-badge", () => ({
  noteUnfocusedAttention,
  clearAttention: vi.fn(),
}))

import { sendTrayNotification } from "./tray"

describe("sendTrayNotification", () => {
  beforeEach(() => {
    show.mockClear()
    noteUnfocusedAttention.mockClear()
    notifications.length = 0
    preferences.notificationMode = "when_unfocused"
    preferences.notificationEvents = { completed: true, failed: true, needs_input: true }
    preferences.notifiedEventIds = []
    getFocusedWindow.mockReturnValue(null)
  })

  it("treats a focused settings window as focused application state", () => {
    getFocusedWindow.mockReturnValue({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false })
    sendTrayNotification({ title: "Vykor", body: "任务已完成。" }, () => null)
    expect(show).not.toHaveBeenCalled()
    expect(noteUnfocusedAttention).not.toHaveBeenCalled()
  })

  it("respects each event switch and deduplicates delivered task events", () => {
    preferences.notificationEvents.failed = false
    sendTrayNotification({ title: "Vykor", body: "SECRET command", eventStatus: "failed", eventId: "f1" }, () => null)
    expect(show).not.toHaveBeenCalled()
    const options = { title: "Vykor", body: "SECRET command", eventStatus: "completed" as const, eventId: "c1" }
    sendTrayNotification(options, () => null)
    sendTrayNotification(options, () => null)
    expect(show).toHaveBeenCalledOnce()
    expect(notifications[0].options).toMatchObject({ body: "任务已完成。" })
    expect(preferences.notifiedEventIds).toEqual(["c1"])
  })

  it("increments attention when a notification arrives while the main window is unfocused", () => {
    const getMainWindow = () => ({
      isFocused: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      isDestroyed: () => false,
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
      (() => ({
        isFocused: () => true,
        isVisible: () => true,
        isMinimized: () => false,
        isDestroyed: () => false,
      })) as never
    )

    expect(noteUnfocusedAttention).not.toHaveBeenCalled()
    expect(show).toHaveBeenCalledOnce()
  })

  it.each(["minimized", "hidden", "unfocused"])("notifies when the main window is %s", (state) => {
    sendTrayNotification({ title: "审核", body: "需要处理" }, (() => ({
      isFocused: () => state !== "unfocused",
      isMinimized: () => state === "minimized",
      isVisible: () => state !== "hidden",
      isDestroyed: () => false,
    })) as never)
    expect(show).toHaveBeenCalledOnce()
  })

  it("does not notify a visible focused window in default mode", () => {
    sendTrayNotification({ title: "审核", body: "需要处理" }, (() => ({
      isFocused: () => true,
      isMinimized: () => false,
      isVisible: () => true,
      isDestroyed: () => false,
    })) as never)
    expect(show).not.toHaveBeenCalled()
  })

  it("restores the window and opens the notification's chat on click", () => {
    const win = {
      isFocused: () => false,
      isMinimized: () => true,
      isVisible: () => true,
      isDestroyed: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    }
    sendTrayNotification(
      { title: "审核", body: "需要处理", sessionId: "chat-2" },
      () => win as never
    )
    notifications[0].click?.()
    expect(win.restore).toHaveBeenCalledOnce()
    expect(win.show).toHaveBeenCalledOnce()
    expect(win.focus).toHaveBeenCalledOnce()
    expect(win.webContents.send).toHaveBeenCalledWith("tray:notification-clicked", "chat-2")
  })
})
