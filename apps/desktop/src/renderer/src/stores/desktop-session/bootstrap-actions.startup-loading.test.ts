// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useDesktopSessionStore } from "./store"
import { refreshedBootstrap, resetDesktopSessionStore } from "./store-test-fixtures"

function mountSplash(): void {
  document.body.innerHTML = `
    <div id="root"></div>
    <div id="startup-loading">splash</div>
  `
}

function stubDesktopSessions(sessions: {
  bootstrap?: () => Promise<unknown>
  daemonStatus?: () => Promise<unknown>
}): void {
  Object.defineProperty(window, "desktop", {
    configurable: true,
    writable: true,
    value: {
      sessions: {
        daemonStatus:
          sessions.daemonStatus ??
          vi.fn(async () => ({
            phase: "ready",
            message: "ready",
            updatedAt: 1,
          })),
        bootstrap: sessions.bootstrap ?? vi.fn(async () => refreshedBootstrap),
        onDaemonStatusChanged: vi.fn(),
      },
    },
  })
}

describe("desktop session initialize splash", () => {
  beforeEach(() => {
    resetDesktopSessionStore()
    mountSplash()
  })

  afterEach(() => {
    document.body.innerHTML = ""
    vi.unstubAllGlobals()
  })

  it("keeps the HTML splash until bootstrap finishes", async () => {
    let finishBootstrap!: (value: typeof refreshedBootstrap) => void
    stubDesktopSessions({
      bootstrap: vi.fn(
        () =>
          new Promise((resolve) => {
            finishBootstrap = resolve
          })
      ),
    })
    useDesktopSessionStore.setState({ loadStatus: "idle" })

    const initialize = useDesktopSessionStore.getState().initialize()
    await vi.waitFor(() => expect(useDesktopSessionStore.getState().loadStatus).toBe("loading"))
    expect(document.getElementById("startup-loading")).not.toBeNull()

    finishBootstrap(refreshedBootstrap)
    await initialize

    expect(useDesktopSessionStore.getState().loadStatus).toBe("ready")
    expect(document.getElementById("startup-loading")?.dataset.startupReady).toBe("true")
  })

  it("marks a leftover splash ready when initialize is already ready", async () => {
    stubDesktopSessions({})
    useDesktopSessionStore.setState({ loadStatus: "ready" })

    await useDesktopSessionStore.getState().initialize()

    expect(document.getElementById("startup-loading")?.dataset.startupReady).toBe("true")
  })

  it("does not mark the splash ready while another initialize is in flight", async () => {
    stubDesktopSessions({})
    useDesktopSessionStore.setState({ loadStatus: "loading" })

    await useDesktopSessionStore.getState().initialize()

    expect(document.getElementById("startup-loading")).not.toBeNull()
  })

  it("marks the splash ready after initialize fails", async () => {
    stubDesktopSessions({
      bootstrap: vi.fn(async () => {
        throw new Error("bootstrap unavailable")
      }),
    })
    useDesktopSessionStore.setState({ loadStatus: "idle" })

    await useDesktopSessionStore.getState().initialize()

    expect(useDesktopSessionStore.getState().loadStatus).toBe("error")
    expect(document.getElementById("startup-loading")?.dataset.startupReady).toBe("true")
  })
})
