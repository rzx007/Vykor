// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { attachDesktopDaemonStatusEvents } from "./bootstrap-actions"
import { useDesktopSessionStore } from "./store"
import { emptySessionView, refreshedBootstrap, resetDesktopSessionStore } from "./store-test-fixtures"

afterEach(() => { resetDesktopSessionStore(); vi.unstubAllGlobals() })
function attach() {
  const callbacks: Record<string, () => void> = {}
  const detach = vi.fn()
  vi.stubGlobal("window", { desktop: { sessions: {
    onDaemonStatusChanged: () => detach,
    onDataDirectoryChanged: (cb: () => void) => { callbacks.data = cb; return detach },
    onDaemonRestarted: (cb: () => void) => { callbacks.restart = cb; return detach },
    bootstrap: vi.fn(async () => refreshedBootstrap),
    open: vi.fn(async (id: string) => emptySessionView(id, 2)),
  } } })
  return { callbacks, detach, close: attachDesktopDaemonStatusEvents({
    get: useDesktopSessionStore.getState, set: useDesktopSessionStore.setState,
    projectDetailsCoordinator: {} as never,
  }) }
}
describe("backend settings lifecycle", () => {
  it("resubscribes the selected conversation after a successful restart", async () => {
    resetDesktopSessionStore()
    useDesktopSessionStore.setState({ activeSessionId: "old", sessionView: emptySessionView("old", 1) })
    const { callbacks, close, detach } = attach()
    callbacks.restart!()
    await vi.waitFor(() => expect(useDesktopSessionStore.getState().sessionView?.cursor).toBe(2))
    expect(useDesktopSessionStore.getState().activeSessionId).toBe("old")
    close()
    expect(detach).toHaveBeenCalledTimes(3)
  })
  it("clears old conversations and refreshes data after switching directories", async () => {
    resetDesktopSessionStore()
    useDesktopSessionStore.setState({ activeSessionId: "old", sessionView: emptySessionView("old", 1), sessionRuntimes: { old: {} as never } })
    const { callbacks, close } = attach()
    callbacks.data!()
    expect(useDesktopSessionStore.getState().activeSessionId).toBeNull()
    expect(useDesktopSessionStore.getState().sessionRuntimes).toEqual({})
    await vi.waitFor(() => expect(useDesktopSessionStore.getState().loadStatus).toBe("ready"))
    expect(window.desktop.sessions.open).not.toHaveBeenCalled()
    close()
  })
})
