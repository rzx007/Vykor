import { beforeAll, describe, expect, it, vi } from "vitest"

import type { router as DesktopRouter } from "./router"

vi.mock("@renderer/components/desktop/layout/main-layout", () => ({
  MainLayout: () => null,
  useMainLayout: () => ({
    conversationWorkspace: null,
    startNewConversation: vi.fn(),
  }),
}))

vi.mock("@renderer/components/desktop/layout/settings-layout", () => ({
  SettingsLayout: () => null,
}))

vi.mock("@renderer/components/desktop/pet-page", () => ({
  PetWindow: () => null,
}))

vi.mock("@renderer/components/desktop/plugin-page", () => ({
  PluginPage: () => null,
}))

vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: Object.assign(() => null, {
    getState: () => ({
      activeSessionId: null,
      archivedSessions: [],
      initialize: vi.fn(),
      sessions: [],
    }),
  }),
}))

let router: typeof DesktopRouter

describe("desktop router", () => {
  beforeAll(async () => {
    ;({ router } = await import("./router"))
  }, 60_000)

  it("builds a stable route for a conversation", () => {
    const location = router.buildLocation({
      to: "/conversation/$sessionId",
      params: { sessionId: "session-123" },
    })

    expect(location.pathname).toBe("/conversation/session-123")
  })

  it("builds routes for scheduled tasks and settings sections", () => {
    expect(router.buildLocation({ to: "/scheduled" }).pathname).toBe("/scheduled")
    expect(router.buildLocation({ to: "/plugins" }).pathname).toBe("/plugins")
    expect(
      router.buildLocation({
        to: "/settings/$section",
        params: { section: "appearance" },
      }).pathname
    ).toBe("/settings/appearance")
  })

  it("places pages under their owning layout routes", () => {
    const routesById = router.routesById as unknown as Record<
      string,
      { parentRoute?: { id: string } }
    >

    expect(routesById["/_main/"].parentRoute?.id).toBe("/_main")
    expect(routesById["/_main/conversation/$sessionId"].parentRoute?.id).toBe("/_main")
    expect(routesById["/_main/scheduled"].parentRoute?.id).toBe("/_main")
    expect(routesById["/_main/plugins"].parentRoute?.id).toBe("/_main")
    expect(routesById["/settings/$section"].parentRoute?.id).toBe("/settings")
    expect(routesById["/pet"].parentRoute?.id).toBe("__root__")
  })
})
