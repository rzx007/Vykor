// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { SIDEBAR_SECTIONS_STORAGE_KEY } from "./sidebar-section-expansion"
import { Sidebar } from "./sidebar"

vi.mock("@tanstack/react-router", () => ({
  useMatchRoute: () => () => false,
}))

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
  motion: {
    div: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
}))

vi.mock("@renderer/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}))

vi.mock("@renderer/components/appearance/appearance-provider", () => ({
  useAppearance: () => ({
    resolvedTheme: "light" as const,
    setPreference: vi.fn(),
  }),
}))

vi.mock("./daemon-autostart-card", () => ({
  DaemonAutoStartCard: () => null,
}))

describe("Sidebar collapsible sections and empty states", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)

    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        tray: { notify: vi.fn() },
      },
    })

    useDesktopSessionStore.setState({
      projects: [],
      sessions: [],
      archivedSessions: [],
      activeSessionId: null,
      loadStatus: "idle",
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    localStorage.clear()
    vi.clearAllMocks()
  })

  it("renders both sections expanded by default and shows empty state text", () => {
    act(() => {
      root.render(
        <Sidebar
          open={true}
          onOpenSettings={vi.fn()}
          onOpenScheduled={vi.fn()}
          onOpenPlugins={vi.fn()}
          onOpenConversation={vi.fn()}
        />
      )
    })

    const buttons = container.querySelectorAll("button")
    const projectSectionBtn = [...buttons].find((b) => b.textContent?.includes("项目"))
    const recentSectionBtn = [...buttons].find((b) => b.textContent?.includes("最近"))

    expect(projectSectionBtn).toBeTruthy()
    expect(projectSectionBtn?.getAttribute("aria-expanded")).toBe("true")
    expect(container.textContent).toContain("暂无项目")

    expect(recentSectionBtn).toBeTruthy()
    expect(recentSectionBtn?.getAttribute("aria-expanded")).toBe("true")
    expect(container.textContent).toContain("暂无最近会话")
  })

  it("can collapse and expand the projects section and saves state to localStorage", async () => {
    act(() => {
      root.render(
        <Sidebar
          open={true}
          onOpenSettings={vi.fn()}
          onOpenScheduled={vi.fn()}
          onOpenPlugins={vi.fn()}
          onOpenConversation={vi.fn()}
        />
      )
    })

    const projectSectionBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("项目")
    )
    expect(projectSectionBtn).toBeTruthy()

    // Collapse projects
    await act(async () => {
      projectSectionBtn?.click()
    })

    expect(projectSectionBtn?.getAttribute("aria-expanded")).toBe("false")
    expect(container.textContent).not.toContain("暂无项目")
    expect(JSON.parse(localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY) ?? "{}")).toMatchObject({
      projects: false,
      recent: true,
    })

    // Expand projects again
    await act(async () => {
      projectSectionBtn?.click()
    })

    expect(projectSectionBtn?.getAttribute("aria-expanded")).toBe("true")
    expect(container.textContent).toContain("暂无项目")
    expect(JSON.parse(localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY) ?? "{}")).toMatchObject({
      projects: true,
      recent: true,
    })
  })

  it("can collapse and expand the recent section and saves state to localStorage", async () => {
    act(() => {
      root.render(
        <Sidebar
          open={true}
          onOpenSettings={vi.fn()}
          onOpenScheduled={vi.fn()}
          onOpenPlugins={vi.fn()}
          onOpenConversation={vi.fn()}
        />
      )
    })

    const recentSectionBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("最近")
    )
    expect(recentSectionBtn).toBeTruthy()

    // Collapse recent
    await act(async () => {
      recentSectionBtn?.click()
    })

    expect(recentSectionBtn?.getAttribute("aria-expanded")).toBe("false")
    expect(container.textContent).not.toContain("暂无最近会话")
    expect(JSON.parse(localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY) ?? "{}")).toMatchObject({
      projects: true,
      recent: false,
    })

    // Expand recent again
    await act(async () => {
      recentSectionBtn?.click()
    })

    expect(recentSectionBtn?.getAttribute("aria-expanded")).toBe("true")
    expect(container.textContent).toContain("暂无最近会话")
    expect(JSON.parse(localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY) ?? "{}")).toMatchObject({
      projects: true,
      recent: true,
    })
  })

  it("restores collapsed state from localStorage on initial render", () => {
    localStorage.setItem(
      SIDEBAR_SECTIONS_STORAGE_KEY,
      JSON.stringify({ projects: false, recent: false })
    )

    act(() => {
      root.render(
        <Sidebar
          open={true}
          onOpenSettings={vi.fn()}
          onOpenScheduled={vi.fn()}
          onOpenPlugins={vi.fn()}
          onOpenConversation={vi.fn()}
        />
      )
    })

    const projectSectionBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("项目")
    )
    const recentSectionBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("最近")
    )

    expect(projectSectionBtn?.getAttribute("aria-expanded")).toBe("false")
    expect(recentSectionBtn?.getAttribute("aria-expanded")).toBe("false")
    expect(container.textContent).not.toContain("暂无项目")
    expect(container.textContent).not.toContain("暂无最近会话")
  })
})
