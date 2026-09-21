// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { createActivityState } from "@renderer/stores/desktop-session/activity-state"
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
      activity: createActivityState(),
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

  function channelSession() {
    return {
      id: "channel-1",
      projectId: "project-1",
      workspaceMode: "outside_project" as const,
      cwd: "/data/channels/feishu/oc_1-abc",
      title: "帮我看下这个报错",
      model: "m",
      status: "idle" as const,
      metadata: { externalConversation: { connector: "feishu" } },
      createdAt: 1,
      updatedAt: 1,
    }
  }

  it("does not render the IM section when there are no channel sessions", () => {
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

    expect(container.textContent).not.toContain("IM 会话")
    expect(container.querySelector('[aria-label="刷新 IM 会话"]')).toBeNull()
  })

  it("renders channel sessions under the IM section, not in recent", () => {
    useDesktopSessionStore.setState({ sessions: [channelSession()] })

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

    expect(container.textContent).toContain("IM 会话")
    expect(container.textContent).toContain("飞书")
    // 标题只出现一次（IM 分区里），没有重复出现在「最近」。
    expect(container.textContent?.split("帮我看下这个报错")).toHaveLength(2)
    expect(container.textContent).toContain("暂无最近会话")
  })

  it("shows one running spinner in the existing right-side action position", () => {
    const session = channelSession()
    useDesktopSessionStore.setState({
      sessions: [session],
      activity: {
        ...createActivityState(),
        sessions: {
          [session.id]: {
            session,
            executionState: "running",
            attentionState: "read",
            activitySeq: 1,
            updatedAt: 1,
          },
        },
      },
    })

    act(() =>
      root.render(
        <Sidebar
          open={true}
          onOpenSettings={vi.fn()}
          onOpenScheduled={vi.fn()}
          onOpenPlugins={vi.fn()}
          onOpenConversation={vi.fn()}
        />
      )
    )

    const rightAction = container.querySelector<HTMLButtonElement>(
      '[aria-label="帮我看下这个报错 正在运行，打开更多操作"]'
    )
    expect(rightAction).not.toBeNull()
    expect(rightAction?.querySelectorAll('[data-slot="spinner"]')).toHaveLength(1)
    expect(rightAction?.parentElement?.querySelectorAll('[data-slot="spinner"]')).toHaveLength(1)
    expect(
      rightAction?.querySelector('[data-slot="spinner"]')?.classList.contains("animate-spin")
    ).toBe(true)
  })

  it("shows an accessible unread result and a Scheduled badge when the page is not mounted", () => {
    const current = channelSession()
    const onOpenConversation = vi.fn()
    useDesktopSessionStore.setState({
      sessions: [current],
      activity: {
        ...createActivityState(),
        initialized: true,
        cursor: 3,
        sessions: {
          [current.id]: {
            session: current,
            executionState: "failed",
            attentionState: "unread",
            activitySeq: 2,
            updatedAt: 2,
          },
        },
        scheduledRuns: {
          run: {
            taskId: "task",
            activitySeq: 3,
            updatedAt: 3,
            executionState: "completed",
            attentionState: "unread",
            run: {
              id: "run",
              taskId: "task",
              status: "succeeded",
              cause: "scheduled",
              scheduledFor: 1,
              unread: true,
              createdAt: 1,
              updatedAt: 3,
            },
          },
        },
      },
    })
    act(() =>
      root.render(
        <Sidebar
          open={true}
          onOpenSettings={vi.fn()}
          onOpenScheduled={vi.fn()}
          onOpenPlugins={vi.fn()}
          onOpenConversation={onOpenConversation}
        />
      )
    )
    const failureIndicator = container.querySelector<HTMLElement>('[aria-label="运行失败"]')
    expect(failureIndicator).not.toBeNull()
    expect(failureIndicator?.classList.contains("right-8")).toBe(true)
    expect(failureIndicator?.querySelector("svg")).toBeNull()
    expect(failureIndicator?.classList.contains("bg-destructive")).toBe(true)
    const sessionButton = failureIndicator?.closest("button")
    expect(sessionButton).not.toBeNull()
    act(() => sessionButton?.click())
    expect(onOpenConversation).toHaveBeenCalledWith(current.id)

    act(() => useDesktopSessionStore.getState().markActivitySessionRead(current.id))
    expect(container.querySelector('[aria-label="运行失败"]')).toBeNull()
    expect(container.querySelector('[aria-label="定时任务，1 个结果待查看"]')).not.toBeNull()
  })

  it("clears a seen interruption but keeps a pending-input indicator", () => {
    const session = channelSession()
    const interrupted = {
      session,
      executionState: "interrupted" as const,
      attentionState: "unread" as const,
      activitySeq: 2,
      updatedAt: 2,
    }
    useDesktopSessionStore.setState({
      sessions: [session],
      activity: {
        ...createActivityState(),
        sessions: { [session.id]: interrupted },
      },
    })
    act(() =>
      root.render(
        <Sidebar
          open={true}
          onOpenSettings={vi.fn()}
          onOpenScheduled={vi.fn()}
          onOpenPlugins={vi.fn()}
          onOpenConversation={vi.fn()}
        />
      )
    )

    expect(container.querySelector('[aria-label="运行中断"]')).not.toBeNull()
    act(() => useDesktopSessionStore.getState().markActivitySessionRead(session.id))
    expect(container.querySelector('[aria-label="运行中断"]')).toBeNull()

    act(() =>
      useDesktopSessionStore.setState((state) => ({
        activity: {
          ...state.activity,
          sessions: {
            ...state.activity.sessions,
            [session.id]: {
              ...state.activity.sessions[session.id],
              executionState: "needs_input",
            },
          },
        },
      }))
    )
    expect(container.querySelector('[aria-label="等待处理"]')).not.toBeNull()
  })

  it("refreshes via the header button but not when expanding the IM section", async () => {
    const refreshBootstrap = vi.fn(async () => {})
    useDesktopSessionStore.setState({ sessions: [channelSession()], refreshBootstrap })

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

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="刷新 IM 会话"]')?.click()
    })
    expect(refreshBootstrap).toHaveBeenCalledTimes(1)

    // Activity 全局事件负责新会话，展开分区不再触发网络刷新。
    const imSectionBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("IM 会话")
    )
    await act(async () => {
      imSectionBtn?.click()
    })
    await act(async () => {
      imSectionBtn?.click()
    })
    expect(refreshBootstrap).toHaveBeenCalledTimes(1)
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
