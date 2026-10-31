import type { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AppContext } from "../../../core/app-context"
import { IpcChannels, type TrayNotificationOptions } from "../../../../shared/ipc-channels"

const { native, preferences, getFocusedWindow, noteUnfocusedAttention } = vi.hoisted(() => ({
  native: {
    supported: true,
    outcome: "pending" as "pending" | "show" | "failed" | "throw",
    instances: [] as (EventEmitter & { options: unknown })[],
    showCalls: 0,
  },
  preferences: {
    notificationMode: "when_unfocused" as "when_unfocused" | "always" | "never",
    notificationEvents: { completed: true, failed: true, needs_input: true },
    notifiedEventIds: [] as string[],
  },
  getFocusedWindow: vi.fn(() => null as unknown),
  noteUnfocusedAttention: vi.fn(),
}))

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events")
  return {
    app: {},
    BrowserWindow: { getFocusedWindow },
    Menu: {},
    nativeImage: {},
    Tray: class {},
    Notification: class extends EventEmitter {
      static isSupported() {
        return native.supported
      }
      constructor(readonly options: unknown) {
        super()
        native.instances.push(this)
      }
      show() {
        native.showCalls += 1
        if (native.outcome === "throw") throw new Error("SECRET native failure")
        if (native.outcome !== "pending") this.emit(native.outcome)
      }
    },
  }
})

vi.mock("../../settings/desktop-preferences", () => ({
  getDesktopPreferences: () => preferences,
  patchDesktopPreferences: (patch: unknown) => Object.assign(preferences, patch),
}))
vi.mock("../attention-badge", () => ({ noteUnfocusedAttention }))
vi.mock("../../main-window/window", () => ({ showMainWindow: vi.fn() }))
vi.mock("../../pet/window", () => ({}))
vi.mock("../../../core/services/lifecycle", () => ({}))

const approval: TrayNotificationOptions = {
  title: "Vykor",
  body: "SECRET command",
  eventStatus: "needs_input",
  eventId: "permission-1",
  sessionId: "chat-1",
}
const visibleWindow = {
  isDestroyed: () => false,
  isVisible: () => true,
  isMinimized: () => false,
}

let sendTrayNotification: typeof import("../tray").sendTrayNotification

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  native.supported = true
  native.outcome = "pending"
  native.instances = []
  native.showCalls = 0
  preferences.notificationMode = "when_unfocused"
  preferences.notificationEvents = { completed: true, failed: true, needs_input: true }
  preferences.notifiedEventIds = []
  getFocusedWindow.mockReturnValue(null)
  noteUnfocusedAttention.mockClear()
  vi.spyOn(console, "warn").mockImplementation(() => {})
  sendTrayNotification = (await import("../tray")).sendTrayNotification
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("native task notification delivery", () => {
  it("uses the supplied focus boundary when a pet owns the native focus", () => {
    getFocusedWindow.mockReturnValue(visibleWindow)
    const hiddenMain = { ...visibleWindow, isVisible: () => false, isFocused: () => false }

    sendTrayNotification(
      approval,
      () => hiddenMain as never,
      () => null
    )

    expect(native.showCalls).toBe(1)
    expect(noteUnfocusedAttention).toHaveBeenCalledOnce()
  })

  it("uses the window manager focus boundary through the tray IPC entry", async () => {
    getFocusedWindow.mockReturnValue(visibleWindow)
    const { trayIpcContribution } = await import("../ipc")
    const ctx = {
      windowManager: { getMain: () => null, getNotificationFocusWindow: () => null },
    } as unknown as AppContext
    const handlers = trayIpcContribution.register(ctx)
    const entry = handlers.find((item) => item.channel === IpcChannels.trayNotify)!

    entry.handler({} as never, approval)

    expect(native.showCalls).toBe(1)
  })

  it("can send the same authorization in the background after focused suppression", () => {
    getFocusedWindow.mockReturnValue(visibleWindow)
    sendTrayNotification(approval, () => null)
    expect(native.showCalls).toBe(0)
    expect(preferences.notifiedEventIds).toEqual([])

    getFocusedWindow.mockReturnValue(null)
    sendTrayNotification(approval, () => null)
    expect(native.showCalls).toBe(1)
  })

  it("does not consume an authorization while native notifications are unsupported", () => {
    native.supported = false
    sendTrayNotification(approval, () => null)
    expect(native.instances).toHaveLength(0)
    expect(preferences.notifiedEventIds).toEqual([])

    native.supported = true
    sendTrayNotification(approval, () => null)
    expect(native.showCalls).toBe(1)
  })

  it("suppresses duplicate attempts in flight and persists only a reported show", () => {
    sendTrayNotification(approval, () => null)
    sendTrayNotification(approval, () => null)
    expect(native.showCalls).toBe(1)
    expect(preferences.notifiedEventIds).toEqual([])

    native.instances[0].emit("show")
    expect(preferences.notifiedEventIds).toEqual(["permission-1"])
    sendTrayNotification(approval, () => null)
    expect(native.showCalls).toBe(1)
  })

  it("allows a retry after the native failed event", () => {
    sendTrayNotification(approval, () => null)
    native.instances[0].emit("failed", {}, "SECRET native failure")
    expect(preferences.notifiedEventIds).toEqual([])

    native.outcome = "show"
    sendTrayNotification(approval, () => null)
    expect(native.showCalls).toBe(2)
    expect(preferences.notifiedEventIds).toEqual(["permission-1"])
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("SECRET")
  })

  it("allows a retry after show throws without exposing the native error", () => {
    native.outcome = "throw"
    expect(() => sendTrayNotification(approval, () => null)).not.toThrow()
    expect(preferences.notifiedEventIds).toEqual([])

    native.outcome = "show"
    sendTrayNotification(approval, () => null)
    expect(native.showCalls).toBe(2)
    expect(preferences.notifiedEventIds).toEqual(["permission-1"])
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("SECRET")
  })

  it("ignores a late result from a failed attempt while its replacement is pending", () => {
    sendTrayNotification(approval, () => null)
    const failedAttempt = native.instances[0]
    failedAttempt.emit("failed")
    expect(failedAttempt.listenerCount("show")).toBe(0)
    expect(failedAttempt.listenerCount("close")).toBe(0)
    sendTrayNotification(approval, () => null)

    failedAttempt.emit("show")
    expect(preferences.notifiedEventIds).toEqual([])
    sendTrayNotification(approval, () => null)
    expect(native.showCalls).toBe(2)

    native.instances[1].emit("show")
    expect(preferences.notifiedEventIds).toEqual(["permission-1"])
  })

  it("releases an unacknowledged attempt after five seconds without retrying it automatically", () => {
    sendTrayNotification(approval, () => null)
    const unacknowledged = native.instances[0]
    vi.advanceTimersByTime(4999)
    sendTrayNotification(approval, () => null)
    expect(native.showCalls).toBe(1)

    vi.advanceTimersByTime(1)
    expect(native.showCalls).toBe(1)
    expect(preferences.notifiedEventIds).toEqual([])
    expect(unacknowledged.listenerCount("show")).toBe(0)
    expect(unacknowledged.listenerCount("failed")).toBe(0)

    sendTrayNotification(approval, () => null)
    expect(native.showCalls).toBe(2)
    unacknowledged.emit("show")
    unacknowledged.emit("failed")
    expect(preferences.notifiedEventIds).toEqual([])
    sendTrayNotification(approval, () => null)
    expect(native.showCalls).toBe(2)

    native.instances[1].emit("show")
    expect(preferences.notifiedEventIds).toEqual(["permission-1"])
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
    sendTrayNotification(approval, () => null)
    expect(native.showCalls).toBe(2)
  })

  it("allows a retry when the native notification closes before reporting a show", () => {
    sendTrayNotification(approval, () => null)
    const closedAttempt = native.instances[0]
    closedAttempt.emit("close")
    expect(preferences.notifiedEventIds).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(closedAttempt.listenerCount("show")).toBe(0)
    expect(closedAttempt.listenerCount("failed")).toBe(0)

    native.outcome = "show"
    sendTrayNotification(approval, () => null)
    expect(native.showCalls).toBe(2)
    expect(preferences.notifiedEventIds).toEqual(["permission-1"])
  })

  it.each(["show", "failed"])(
    "clears the waiting timer and result listeners after %s",
    (result) => {
      sendTrayNotification(approval, () => null)
      expect(vi.getTimerCount()).toBe(1)

      const notification = native.instances[0]
      notification.emit(result)

      expect(vi.getTimerCount()).toBe(0)
      expect(notification.listenerCount("show")).toBe(0)
      expect(notification.listenerCount("failed")).toBe(0)
      expect(notification.listenerCount("close")).toBe(0)
    }
  )

  it("keeps independently shown events when native results arrive out of order", () => {
    sendTrayNotification(approval, () => null)
    sendTrayNotification({ ...approval, eventId: "permission-2" }, () => null)

    native.instances[1].emit("show")
    expect(preferences.notifiedEventIds).toEqual(["permission-2"])
    native.instances[0].emit("show")

    expect(preferences.notifiedEventIds).toHaveLength(2)
    expect(preferences.notifiedEventIds).toEqual(
      expect.arrayContaining(["permission-1", "permission-2"])
    )
  })

  it("preserves the focused always mode and redacts authorization details", () => {
    preferences.notificationMode = "always"
    native.outcome = "show"
    getFocusedWindow.mockReturnValue(visibleWindow)

    sendTrayNotification(approval, () => null)
    sendTrayNotification(approval, () => null)

    expect(native.showCalls).toBe(1)
    expect(native.instances[0].options).toMatchObject({ body: "任务正在等待你处理。" })
    expect(preferences.notifiedEventIds).toEqual(["permission-1"])
    expect(noteUnfocusedAttention).not.toHaveBeenCalled()
  })
})
