import { createMemoryHistory, createRouter } from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { selectActiveSessionComposerError } from "@renderer/stores/desktop-session/selectors"
import {
  emptySessionView,
  resetDesktopSessionStore,
} from "@renderer/stores/desktop-session/store-test-fixtures"
import { routeTree } from "@renderer/routeTree.gen"

vi.mock("./__root", async () => {
  const { createRootRoute } = await import("@tanstack/react-router")
  return { Route: createRootRoute() }
})

vi.mock("@renderer/components/desktop/layout/main-layout", () => ({
  MainLayout: () => null,
  useMainLayout: () => ({ conversationWorkspace: null }),
}))
vi.mock("@renderer/components/desktop/layout/settings-layout", () => ({
  SettingsLayout: () => null,
}))
vi.mock("@renderer/components/desktop/settings-page/settings-content", () => ({
  SettingsContent: () => null,
}))
vi.mock("@renderer/components/desktop/pet-page", () => ({ PetWindow: () => null }))
vi.mock("@renderer/components/desktop/plugin-page", () => ({ PluginPage: () => null }))

function navigationRouter(path: string) {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    isServer: false,
  })
}

describe("conversation navigation", () => {
  beforeEach(() => {
    resetDesktopSessionStore()
    useDesktopSessionStore.setState({ loadStatus: "ready" })
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each(["/", "/conversation/unavailable"])(
    "keeps a failed session open at %s without redirecting repeatedly",
    async (path) => {
      const open = vi.fn().mockRejectedValue(new Error("会话不可用"))
      vi.stubGlobal("window", { desktop: { sessions: { open } } })
      if (path === "/") {
        await useDesktopSessionStore.getState().openSession("unavailable")
        open.mockClear()
      }
      const router = navigationRouter(path)

      await router.load()

      expect(router.state.matches.map((match) => match.error).filter(Boolean)).toEqual([])
      expect(router.state.matches.every((match) => match.status === "success")).toBe(true)
      expect(router.state.location.pathname).toBe("/conversation/unavailable")
      expect(open).toHaveBeenCalledTimes(1)
      expect(selectActiveSessionComposerError(useDesktopSessionStore.getState())).toBe("会话不可用")
    }
  )

  it("opens a healthy session and allows retry after a failed open", async () => {
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error("暂时无法连接"))
      .mockResolvedValue(emptySessionView("session-1"))
    vi.stubGlobal("window", { desktop: { sessions: { open } } })
    const router = navigationRouter("/conversation/session-1")

    await router.load()
    expect(selectActiveSessionComposerError(useDesktopSessionStore.getState())).toBe("暂时无法连接")
    await router.invalidate()

    expect(router.state.location.pathname).toBe("/conversation/session-1")
    expect(useDesktopSessionStore.getState().sessionView?.session.id).toBe("session-1")
    expect(selectActiveSessionComposerError(useDesktopSessionStore.getState())).toBeNull()
    expect(open).toHaveBeenCalledTimes(2)
  })

  it("returns to the start page when opening is superseded by a new conversation", async () => {
    let resolveOpen!: (view: ReturnType<typeof emptySessionView>) => void
    const open = vi.fn(
      () =>
        new Promise<ReturnType<typeof emptySessionView>>((resolve) => {
          resolveOpen = resolve
        })
    )
    vi.stubGlobal("window", { desktop: { sessions: { open, close: vi.fn() } } })
    const router = navigationRouter("/conversation/session-1")
    const loading = router.load()
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())

    await useDesktopSessionStore.getState().startNewConversation()
    resolveOpen(emptySessionView("session-1"))
    await loading

    expect(router.state.location.pathname).toBe("/")
    expect(router.state.matches.every((match) => match.status === "success")).toBe(true)
    expect(useDesktopSessionStore.getState().activeSessionId).toBeNull()
    expect(open).toHaveBeenCalledTimes(1)
  })
})
