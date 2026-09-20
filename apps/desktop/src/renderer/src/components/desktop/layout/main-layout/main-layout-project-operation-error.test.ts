// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopOperation, DesktopSessionState } from "@renderer/stores/desktop-session/types"

vi.mock("@tanstack/react-router", async () => {
  const { useContext } = await import("react")
  const { MainLayoutContext } = await import("./main-layout-context")

  return {
    Outlet: () => useContext(MainLayoutContext)?.conversationWorkspace ?? null,
    useNavigate: () => vi.fn(),
    useMatchRoute: () => () => false,
    useRouter: () => ({
      history: {
        back: vi.fn(),
        forward: vi.fn(),
        canGoBack: () => false,
        canGoForward: () => false,
      },
    }),
    useRouterState: () => 0,
  }
})

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children?: React.ReactNode }) => children,
  Panel: ({ children }: { children?: React.ReactNode }) => children,
  useDefaultLayout: () => ({ defaultLayout: null, onLayoutChanged: vi.fn() }),
  useGroupRef: () => ({ current: null }),
  usePanelRef: () => ({ current: null }),
}))

vi.mock("@renderer/components/desktop/settings-page/settings-navigation", () => ({
  defaultSettingsSection: "general",
}))
vi.mock("@renderer/components/desktop/open-with", () => ({ OpenWithSplitButton: () => null }))
vi.mock("@renderer/components/appearance/appearance-provider", () => ({
  useAppearance: () => ({
    resolvedTheme: "light" as const,
    setPreference: vi.fn(),
  }),
}))
vi.mock("@renderer/components/desktop/use-desktop-shortcuts", () => ({
  useDesktopShortcuts: () => undefined,
}))
vi.mock("@renderer/components/ui/panel-resize-handle", () => ({
  PanelResizeHandle: () => null,
}))
vi.mock("@renderer/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children?: React.ReactNode }) => children,
}))
vi.mock("@renderer/components/desktop/layout/title-bar", () => ({ TitleBar: () => null }))
vi.mock("@renderer/components/desktop/layout/use-desktop-window-chrome", () => ({
  useDesktopWindowChrome: () => ({
    isMaximized: false,
    zoomLevel: 1,
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetZoom: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}))
vi.mock("@renderer/hooks/use-active-workspace-is-git", () => ({
  useActiveWorkspaceIsGit: () => false,
}))
vi.mock("@renderer/components/desktop/layout/main-layout/utility-panel", () => ({
  UtilityPanel: () => null,
  useUtilityPanelController: () => ({
    open: false,
    maximized: false,
    visibleLayout: { conversation: 100, utility: 0 },
    toggle: vi.fn(),
    openFile: vi.fn(),
    openReview: vi.fn(),
    openTerminal: vi.fn(),
    openTool: vi.fn(),
    handleLayoutChanged: vi.fn(),
    handlePanelResize: vi.fn(),
    collapse: vi.fn(),
    instanceKey: "test",
    scopeId: "test",
    fileOpenRequest: null,
    reviewOpenRequest: null,
    terminalOpenRequest: null,
    toolOpenRequest: null,
  }),
}))
vi.mock("@renderer/stores/desktop-session", async () => {
  const actual = await vi.importActual<typeof import("@renderer/stores/desktop-session")>(
    "@renderer/stores/desktop-session"
  )

  return { ...actual, attachDesktopSessionEvents: () => () => undefined }
})

import { MainLayout } from "./main-layout"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"

const initialStoreState = useDesktopSessionStore.getState()
let mountedRoot: Root | null = null
let mountedContainer: HTMLDivElement | null = null

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  useDesktopSessionStore.setState(stateWith({}), true)
})

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount())
    mountedContainer?.remove()
    mountedRoot = null
    mountedContainer = null
  }
  useDesktopSessionStore.setState(initialStoreState, true)
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

function stateWith(overrides: Partial<DesktopSessionState>): DesktopSessionState {
  return {
    ...initialStoreState,
    appOperations: {},
    activeSessionId: null,
    applySessionUpdate: vi.fn(),
    archivedSessions: [],
    branch: null,
    branches: [],
    cancelQueuedPrompt: vi.fn(async () => undefined),
    checkoutBranch: vi.fn(async () => undefined),
    chooseProject: vi.fn(async () => undefined),
    createAndCheckoutBranch: vi.fn(async () => undefined),
    daemonStatus: { phase: "ready", message: "已连接", updatedAt: 1 },
    defaultModel: null,
    defaultPermissionMode: "default",
    defaultProvider: null,
    deleteSession: vi.fn(async () => undefined),
    editLatestMessage: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => ({}) as DesktopSessionState["forkSession"]),
    initialize: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    loadStatus: "idle",
    models: [],
    newConversationRuntime: {
      operations: {},
      pendingPromptEdit: null,
      pendingPromptSubmissions: {},
      queuedPromptActions: {},
    },
    openSession: vi.fn(async () => undefined),
    projectOperations: {},
    projects: [],
    promoteQueuedPrompt: vi.fn(async () => undefined),
    rebindProject: vi.fn(async () => undefined),
    refreshBootstrap: vi.fn(async () => undefined),
    refreshSelectedProjectGit: vi.fn(async () => false),
    removeProject: vi.fn(async () => undefined),
    renameProject: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    replyPermission: vi.fn(async () => undefined),
    selectModel: vi.fn(async () => undefined),
    selectOutsideProject: vi.fn(),
    selectPermissionMode: vi.fn(async () => undefined),
    selectProject: vi.fn(async () => undefined),
    selectedModel: null,
    selectedPermissionMode: "default",
    selectedProject: null,
    selectedProjectGit: false,
    selectedProjectGitCheckedAt: null,
    selectedProvider: null,
    sendMessage: vi.fn(async () => undefined),
    sessionRuntimes: {},
    sessions: [],
    sessionView: null,
    startNewConversation: vi.fn(),
    startConversationFrom: vi.fn(async () => undefined),
    startSession: vi.fn(async () => null),
    togglePinProject: vi.fn(async () => undefined),
    togglePinSession: vi.fn(async () => undefined),
    updateSessionModel: vi.fn(async () => undefined),
    updateSessionPermissionMode: vi.fn(async () => undefined),
    workspaceMode: "project",
    ...overrides,
  } as DesktopSessionState
}

function project(id: string, name: string): NonNullable<DesktopSessionState["selectedProject"]> {
  return { id, name, path: `D:\\${id}`, lastOpenedAt: 1, available: true }
}

function session(
  id: string,
  status: "idle" | "archived"
): NonNullable<DesktopSessionState["sessionView"]>["session"] {
  return {
    id,
    cwd: `D:\\${id}`,
    title: `${id} 会话`,
    model: "test-model",
    status,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

function sessionView(
  id: string,
  status: "idle" | "archived"
): NonNullable<DesktopSessionState["sessionView"]> {
  return {
    cursor: 1,
    syncStatus: "connected",
    session: session(id, status),
    inputs: [],
    messages: [],
    parts: [],
    runs: [],
    tasks: [],
    permissions: [],
  }
}

function failedProjectOperation(projectId: string, error: string): DesktopOperation {
  return {
    id: `${projectId}:operation`,
    kind: "project-action" as const,
    phase: "failed" as const,
    sessionId: null,
    projectId,
    startedAt: 1,
    finishedAt: 2,
    error,
  }
}

function mountLayout(state: DesktopSessionState): HTMLDivElement {
  useDesktopSessionStore.setState(state, true)
  const container = document.createElement("div")
  document.body.append(container)
  mountedContainer = container
  mountedRoot = createRoot(container)

  act(() => {
    mountedRoot?.render(createElement(MainLayout))
  })

  return container
}

describe("MainLayout selected project operation error owner", () => {
  it("keeps an older bootstrap without attachment support on the text-only composer", () => {
    const container = mountLayout(
      stateWith({
        attachmentSupport: undefined as never,
        selectedProject: project("project-a", "项目 A"),
        projects: [project("project-a", "项目 A")],
      })
    )

    expect(container.textContent).not.toContain("开始使用")
    expect(container.querySelector('[aria-label="添加文件"]')).toBeNull()
  })

  it("shows the selected project failure while the active conversation is archived", () => {
    const error = "归档会话中的项目操作失败"
    const selectedProject = project("project-a", "项目 A")
    const archivedSession = session("session-archived", "archived")
    const container = mountLayout(
      stateWith({
        activeSessionId: "session-archived",
        archivedSessions: [archivedSession],
        projects: [selectedProject],
        sessionView: sessionView("session-archived", "archived"),
        selectedProject,
        sessions: [archivedSession],
        projectOperations: {
          "project-a": {
            operation: failedProjectOperation("project-a", error),
          },
        },
      })
    )

    expect(container.textContent).toContain(error)
    expect(container.textContent?.split(error)).toHaveLength(2)
    expect(container.textContent).toContain("此会话已归档，只能查看历史内容")
    expect(container.textContent).not.toContain("开始使用")
  })

  it.each([
    ["an active conversation", "session-active"],
    ["a new conversation", null],
  ])("shows a selected project failure once for %s", (_mode, activeSessionId) => {
    const error = "项目操作失败"
    const selectedProject = project("project-a", "项目 A")
    const activeSession = activeSessionId ? session(activeSessionId, "idle") : null
    const container = mountLayout(
      stateWith({
        activeSessionId,
        projects: [selectedProject],
        selectedProject,
        sessionView: activeSession ? sessionView(activeSession.id, "idle") : null,
        sessions: activeSession ? [activeSession] : [],
        projectOperations: {
          "project-a": {
            operation: failedProjectOperation("project-a", error),
          },
        },
      })
    )

    expect(container.textContent?.split(error)).toHaveLength(2)
    expect(container.textContent).not.toContain("开始使用")
    expect(
      container.querySelector(activeSession ? "h1" : "#new-conversation-composer")
    ).not.toBeNull()
  })

  it("updates the mounted layout from project A's error to project B's error", () => {
    const projectA = project("project-a", "项目 A")
    const projectB = project("project-b", "项目 B")
    const container = mountLayout(
      stateWith({
        projects: [projectA, projectB],
        selectedProject: projectA,
        projectOperations: {
          "project-a": {
            operation: failedProjectOperation("project-a", "项目 A 操作失败"),
          },
          "project-b": {
            operation: failedProjectOperation("project-b", "项目 B 操作失败"),
          },
        },
      })
    )

    expect(container.textContent).toContain("项目 A 操作失败")
    expect(container.textContent).not.toContain("项目 B 操作失败")

    act(() => {
      useDesktopSessionStore.setState({ selectedProject: projectB })
    })

    expect(container.textContent).not.toContain("项目 A 操作失败")
    expect(container.textContent).toContain("项目 B 操作失败")
    expect(container.textContent?.split("项目 B 操作失败")).toHaveLength(2)
  })
})
