// @vitest-environment jsdom
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const sessionEvents = vi.hoisted(() => ({
  detach: vi.fn(),
  attach: vi.fn(() => sessionEvents.detach),
  initialize: vi.fn<() => Promise<void>>(async () => undefined),
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
  useDesktopSessionStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        appOperations: {},
        daemonStatus: { phase: "ready", message: "正在恢复会话", updatedAt: 1 },
      }),
    {
      getState: () => ({
        initialize: sessionEvents.initialize,
        sessionView: { session: { id: "session-1" } },
      }),
    }
  ),
}))

import { routeTree } from "./routeTree.gen"

it("opens the notification's chat from settings and releases the click listener", async () => {
  let onClick: ((sessionId: string) => void) | undefined
  const detach = vi.fn()
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      notificationSettings: { resolveSession: async (sessionId: string) => ({ id: sessionId }) },
      tray: {
        onNotificationClick(listener: (sessionId: string) => void) {
          onClick = listener
          return detach
        },
      },
    },
  })
  const router = await mountRouter("/settings/general")
  expect(onClick).toBeTypeOf("function")
  await act(async () => {
    onClick!("session-1")
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(router.state.location.pathname).toBe("/conversation/session-1")
  act(() => root.unmount())
  expect(detach).toHaveBeenCalledOnce()
  root = createRoot(container)
  delete (window as unknown as { desktop?: unknown }).desktop
})

it("keeps settings open when a notification's session has been deleted", async () => {
  let onClick: ((sessionId: string) => void) | undefined
  Object.defineProperty(window, "desktop", { configurable: true, value: {
    notificationSettings: { resolveSession: async () => null },
    tray: { onNotificationClick(listener: (id: string) => void) { onClick = listener; return () => {} } },
  } })
  const router = await mountRouter("/settings/general")
  await act(async () => { onClick!("deleted-session"); await new Promise((resolve) => setTimeout(resolve, 20)) })
  expect(router.state.location.pathname).toBe("/settings/general")
  expect(document.body.textContent).toContain("通知对应的会话已删除")
  delete (window as unknown as { desktop?: unknown }).desktop
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
  sessionEvents.attach.mockClear()
  sessionEvents.detach.mockClear()
  sessionEvents.initialize.mockReset()
  sessionEvents.initialize.mockResolvedValue(undefined)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  expect(sessionEvents.detach).toHaveBeenCalledTimes(sessionEvents.attach.mock.calls.length)
  container.remove()
  document.getElementById("startup-loading")?.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it("marks startup ready only after the route page has committed", async () => {
  const overlay = document.createElement("div")
  overlay.id = "startup-loading"
  document.body.append(overlay)

  await mountRouter("/conversation/session-1")

  expect(container.textContent).toBe("Conversation")
  expect(overlay.dataset.startupReady).toBe("true")
})

it("keeps the splash while child route initialization is pending, then reveals the committed page", async () => {
  let finishInitialization!: () => void
  sessionEvents.initialize.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishInitialization = resolve
      })
  )
  const overlay = document.createElement("div")
  overlay.id = "startup-loading"
  document.body.append(overlay)
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/conversation/session-1"] }),
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  })

  await act(async () => root.render(<RouterProvider router={router} />))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(container.textContent).toBe("")
  expect(overlay.dataset.startupReady).toBeUndefined()

  await act(async () => {
    sessionEvents.initialize.mockResolvedValue(undefined)
    finishInitialization()
    await router.load()
  })
  expect(container.textContent).toBe("Conversation")
  expect(overlay.dataset.startupReady).toBe("true")
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
