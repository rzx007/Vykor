// @vitest-environment jsdom
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const sessionEvents = vi.hoisted(() => ({
  detach: vi.fn(),
  attach: vi.fn(() => sessionEvents.detach),
}))

// Keep the real route tree, root component and bridge; replace page bodies and IPC/store boundary.
vi.mock("@renderer/components/desktop/layout/main-layout", () => ({
  MainLayout: () => <Outlet />,
  useMainLayout: () => ({ conversationWorkspace: <p>Conversation</p> }),
}))
vi.mock("@renderer/components/desktop/layout/settings-layout", () => ({
  SettingsLayout: () => <Outlet />,
}))
vi.mock("@renderer/components/desktop/settings-page", () => ({
  SettingsContent: () => <p>Settings</p>,
}))
vi.mock("@renderer/components/desktop/pet-page", () => ({
  PetWindow: () => <p>Pet</p>,
}))
vi.mock("@renderer/components/desktop/plugin-page", () => ({
  PluginPage: () => null,
}))
vi.mock("@renderer/stores/desktop-session", () => ({
  attachDesktopSessionEvents: sessionEvents.attach,
  useDesktopSessionStore: Object.assign(() => null, {
    getState: () => ({
      initialize: async () => undefined,
      sessionView: { session: { id: "session-1" } },
    }),
  }),
}))

import { routeTree } from "./routeTree.gen"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
  sessionEvents.attach.mockClear()
  sessionEvents.detach.mockClear()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  expect(sessionEvents.detach).toHaveBeenCalledTimes(sessionEvents.attach.mock.calls.length)
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mountRouter(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await router.load()
  await act(async () => root.render(<RouterProvider router={router} />))
  return router
}

it("keeps the root session subscription across conversation → settings → conversation", async () => {
  const router = await mountRouter("/conversation/session-1")
  expect(container.textContent).toBe("Conversation")
  expect(sessionEvents.attach).toHaveBeenCalledTimes(1)

  await act(async () => {
    await router.navigate({ to: "/settings/$section", params: { section: "general" } })
  })
  expect(container.textContent).toBe("Settings")
  expect(sessionEvents.attach).toHaveBeenCalledTimes(1)
  expect(sessionEvents.detach).not.toHaveBeenCalled()

  await act(async () => {
    await router.navigate({ to: "/conversation/$sessionId", params: { sessionId: "session-1" } })
  })
  expect(container.textContent).toBe("Conversation")
  // No new attach means no re-entry into attach's active-session recovery sync.
  expect(sessionEvents.attach).toHaveBeenCalledTimes(1)
  expect(sessionEvents.detach).not.toHaveBeenCalled()
})

it("does not subscribe when the real root starts at /pet", async () => {
  await mountRouter("/pet")
  expect(container.textContent).toBe("Pet")
  expect(sessionEvents.attach).not.toHaveBeenCalled()
  expect(sessionEvents.detach).not.toHaveBeenCalled()
})
