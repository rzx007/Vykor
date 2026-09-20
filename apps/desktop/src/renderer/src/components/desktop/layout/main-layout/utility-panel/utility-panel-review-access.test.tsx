// @vitest-environment jsdom

import { act, createElement } from "react"
import type * as React from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopSessionView } from "@shared/session-types"

import { resetWorkspaceGitProbeCacheForTests } from "@renderer/lib/workspace-git-probe"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"

vi.mock("@renderer/components/desktop/tools/review-tool", async () => {
  const { createElement: h } = await import("react")
  return { ReviewTool: () => h("div", { "data-testid": "review-tool" }) }
})

import { UtilityPanel } from "./utility-panel"
import { readUtilityPanelRuntimeState } from "./utility-panel-repository"

const initialStoreState = useDesktopSessionStore.getState()
let mountedRoot: Root | null = null
let mountedContainer: HTMLDivElement | null = null

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  useDesktopSessionStore.setState(initialStoreState, true)
  resetWorkspaceGitProbeCacheForTests()
})

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount())
    mountedContainer?.remove()
    mountedRoot = null
    mountedContainer = null
  }
  useDesktopSessionStore.setState(initialStoreState, true)
  resetWorkspaceGitProbeCacheForTests()
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

function installProbe(
  isRepository: (options: { path: string }) => Promise<{ isRepository: boolean; rootPath: null }>
): ReturnType<typeof vi.fn> {
  const probe = vi.fn(isRepository)
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { git: { isRepository: probe } },
  })
  return probe
}

function outsideProjectSessionView(id = "s1", cwd = "D:/repo"): DesktopSessionView {
  const view = emptySessionView(id)
  return {
    ...view,
    session: { ...view.session, cwd, workspaceMode: "outside_project" },
  }
}

function useOutsideProjectSession(cwd: string): void {
  useDesktopSessionStore.setState({
    selectedProject: null,
    selectedProjectGit: false,
    activeSessionId: "s1",
    sessionView: outsideProjectSessionView("s1", cwd),
  })
}

async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function mountPanel(
  scopeId: string,
  overrides: Partial<React.ComponentProps<typeof UtilityPanel>> = {}
): HTMLDivElement {
  const container = document.createElement("div")
  document.body.append(container)
  mountedContainer = container
  mountedRoot = createRoot(container)

  act(() => {
    mountedRoot?.render(
      createElement(UtilityPanel, {
        scopeId,
        open: true,
        maximized: false,
        onToggleMaximized: vi.fn(),
        onClose: vi.fn(),
        fileOpenRequest: null,
        reviewOpenRequest: null,
        terminalOpenRequest: null,
        toolOpenRequest: null,
        onOpenFile: vi.fn(),
        onOpenReview: vi.fn(),
        onOpenTerminal: vi.fn(),
        ...overrides,
      })
    )
  })

  return container
}

describe("UtilityPanel review tool access", () => {
  it("offers the review tool once the probe reports a repository", async () => {
    const isRepository = installProbe(async () => ({ isRepository: true, rootPath: null }))
    useOutsideProjectSession("D:/repo-one")

    const container = mountPanel("session:review-access-git")
    await settle()

    expect(isRepository).toHaveBeenCalledWith({ path: "D:/repo-one" })
    expect(container.textContent).toContain("审阅")
  })

  it("opens and activates the review tab when the probe reports a repository", async () => {
    installProbe(async () => ({ isRepository: true, rootPath: null }))
    useOutsideProjectSession("D:/repo-one")

    const container = mountPanel("session:review-open-git", {
      reviewOpenRequest: { id: 1 },
    })
    await settle()

    expect(container.querySelector('[data-testid="review-tool"]')).not.toBeNull()
    expect(container.textContent).toContain("审阅")
    expect(readUtilityPanelRuntimeState("session:review-open-git")?.activeTabId).toBe("review-tab")
  })

  it("removes an open review tab when the active workspace is no longer a repository", async () => {
    installProbe(async ({ path }) => ({
      isRepository: path === "D:/repo-one",
      rootPath: null,
    }))
    useOutsideProjectSession("D:/repo-one")

    const scopeId = "session:review-close-transition"
    const container = mountPanel(scopeId, { reviewOpenRequest: { id: 1 } })
    await settle()
    expect(container.querySelector('[data-testid="review-tool"]')).not.toBeNull()

    await act(async () => {
      useOutsideProjectSession("D:/plain-dir")
    })
    await settle()

    expect(container.querySelector('[data-testid="review-tool"]')).toBeNull()
    expect(container.textContent).not.toContain("审阅")
    expect(readUtilityPanelRuntimeState(scopeId)?.tabs.some((tab) => tab.tool === "review")).toBe(
      false
    )
  })

  it("hides the review tool when the probe reports a non-repository", async () => {
    const isRepository = installProbe(async () => ({ isRepository: false, rootPath: null }))
    useOutsideProjectSession("D:/plain-dir")

    const container = mountPanel("session:review-access-no-git")
    await settle()

    expect(isRepository).toHaveBeenCalledWith({ path: "D:/plain-dir" })
    expect(container.textContent).not.toContain("审阅")
  })

  it("does not open the review tab when the probe reports a non-repository", async () => {
    installProbe(async () => ({ isRepository: false, rootPath: null }))
    useOutsideProjectSession("D:/plain-dir")

    const scopeId = "session:review-request-no-git"
    const container = mountPanel(scopeId, { reviewOpenRequest: { id: 1 } })
    await settle()

    expect(container.querySelector('[data-testid="review-tool"]')).toBeNull()
    expect(container.textContent).not.toContain("审阅")
    expect(readUtilityPanelRuntimeState(scopeId)?.tabs.some((tab) => tab.tool === "review")).toBe(
      false
    )
  })

  it("hides the review tool while the probe is still pending", () => {
    installProbe(() => new Promise(() => {}))
    useOutsideProjectSession("D:/repo-one")

    const container = mountPanel("session:review-access-unknown")

    expect(container.textContent).not.toContain("审阅")
  })
})
