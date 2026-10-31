import { EventEmitter } from "node:events"
import type { BrowserWindow, WebContents } from "electron"
import { describe, expect, it, vi } from "vitest"

vi.mock("../../main-window/window", () => ({
  showMainWindow: (win: BrowserWindow) => {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  },
}))

import { notificationNavigationReady, openNotificationSession } from "../notification-navigation"
import { IpcEvents } from "../../../../shared/ipc-channels"

function windowFixture() {
  const messages: unknown[][] = []
  let destroyed = false
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    send: (...args: unknown[]) => messages.push(args),
  })
  const actions: string[] = []
  const win = {
    webContents: contents,
    isDestroyed: () => destroyed,
    isMinimized: () => true,
    restore: () => actions.push("restore"),
    show: () => actions.push("show"),
    focus: () => actions.push("focus"),
  } as unknown as BrowserWindow
  return {
    win,
    contents: contents as unknown as WebContents,
    messages,
    actions,
    destroy: () => {
      destroyed = true
    },
  }
}

describe("notification navigation", () => {
  it("holds the newest clicked conversation until its renderer subscribes", () => {
    const fixture = windowFixture()
    openNotificationSession("chat-1", () => fixture.win)
    openNotificationSession("chat-2", () => fixture.win)
    expect(fixture.messages).toEqual([])
    expect(fixture.actions).toEqual(["restore", "show", "focus", "restore", "show", "focus"])

    notificationNavigationReady(fixture.contents)
    notificationNavigationReady(fixture.contents)
    expect(fixture.messages).toEqual([[IpcEvents.trayNotificationClicked, "chat-2"]])
  })

  it("delivers immediately after subscription and waits again across renderer reloads", () => {
    const fixture = windowFixture()
    notificationNavigationReady(fixture.contents)
    openNotificationSession("chat-1", () => fixture.win)
    expect(fixture.messages).toEqual([[IpcEvents.trayNotificationClicked, "chat-1"]])

    fixture.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
    openNotificationSession("chat-2", () => fixture.win)
    expect(fixture.messages).toHaveLength(1)
    notificationNavigationReady(fixture.contents)
    expect(fixture.messages).toEqual([
      [IpcEvents.trayNotificationClicked, "chat-1"],
      [IpcEvents.trayNotificationClicked, "chat-2"],
    ])
  })

  it.each([
    { name: "a child frame loading", isMainFrame: false, isSameDocument: false },
    { name: "same-document routing", isMainFrame: true, isSameDocument: true },
  ])("keeps the renderer ready during $name", ({ isMainFrame, isSameDocument }) => {
    const fixture = windowFixture()
    notificationNavigationReady(fixture.contents)
    fixture.contents.emit("did-start-navigation", { isMainFrame, isSameDocument })
    if (!isMainFrame) fixture.contents.emit("did-start-loading")

    openNotificationSession("chat-1", () => fixture.win)
    expect(fixture.messages).toEqual([[IpcEvents.trayNotificationClicked, "chat-1"]])
  })

  it("never gives another window the pending conversation or sends to destroyed contents", () => {
    const main = windowFixture()
    const other = windowFixture()
    openNotificationSession("chat-1", () => main.win)
    notificationNavigationReady(other.contents)
    expect(main.messages).toEqual([])
    expect(other.messages).toEqual([])

    main.destroy()
    notificationNavigationReady(main.contents)
    openNotificationSession("chat-2", () => main.win)
    openNotificationSession("chat-3", () => null)
    expect(main.messages).toEqual([])
  })
})
