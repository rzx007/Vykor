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
import { PluginUiProvider } from "@renderer/components/desktop/conversation-page/plugin-ui/plugin-ui-provider"
import { PluginUiCard } from "@renderer/components/desktop/conversation-page/plugin-ui/plugin-ui-card"
import {
  instance,
  snapshot,
  sourcePart,
} from "@renderer/components/desktop/conversation-page/plugin-ui/plugin-ui-fixtures.test-support"
import { utilityToolOrder } from "./utility-panel-tabs"
import { readUtilityPanelRuntimeState } from "./utility-panel-repository"
import { imageSourceKey } from "@renderer/components/desktop/image-viewer/image-source"

// 图片编辑器自身另有集成测试；这里验证真实 panel 的标签和会话缓存。
vi.mock("@renderer/components/desktop/image-viewer/image-viewer-panel", () => ({
  ImageViewerPanel: () => null,
}))

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
  it("deduplicates an attachment image by identity and removes it through the normal tab close action", async () => {
    installProbe(async () => ({ isRepository: false, rootPath: null }))
    useOutsideProjectSession("D:/plain-dir")
    const scopeId = "session:image-tabs"
    const source = { kind: "attachment" as const, assetId: "one", name: "image.png" }
    const container = mountPanel(scopeId, { imageOpenRequest: { id: 1, source } })
    await settle()
    const renderRequest = (id: number) =>
      mountedRoot!.render(
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
          imageOpenRequest: { id, source },
          onOpenFile: vi.fn(),
          onOpenReview: vi.fn(),
          onOpenTerminal: vi.fn(),
        })
      )
    await act(async () => renderRequest(2))
    await settle()
    expect(readUtilityPanelRuntimeState(scopeId)!.tabs).toEqual([
      { id: imageSourceKey(source), tool: "image", title: "image.png", imageSource: source },
    ])
    expect(container.querySelector(".utility-tab-strip")?.textContent).toContain("image.png")
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="关闭标签"]')!.click()
    )
    await settle()
    expect(readUtilityPanelRuntimeState(scopeId)!.tabs).toEqual([])
  })
  it("opens only a concrete plugin instance and closes its display without dismissing business", async () => {
    installProbe(async () => ({ isRepository: true, rootPath: null }))
    useOutsideProjectSession("D:/repo-one")
    const actualInstance = { ...instance, sessionId: "s1" }
    const actualPart = { ...sourcePart, sessionId: "s1", metadata: { pluginUi: actualInstance } }
    useDesktopSessionStore.setState((state) => ({
      sessionView: { ...state.sessionView!, parts: [actualPart] },
    }))
    const hostState = {
      snapshot,
      plugin: { id: "example.ui", version: "1" },
      title: "检查结果",
      availability: { code: "available", canRender: true, canInvoke: true },
      surfaces: instance.surfaces,
      actions: [],
    }
    const unmount = vi.fn(async () => {}),
      dismiss = vi.fn()
    Object.assign(window.desktop, {
      pluginUi: {
        capabilities: async () => ({ available: true }),
        mount: async () => ({
          mountId: "20000000-0000-4000-8000-000000000001",
          url: "vykor-plugin-ui://frame/20000000-0000-4000-8000-000000000001",
          state: hostState,
        }),
        getState: async () => hostState,
        onRevoked: () => () => {},
        unmount,
        dismiss,
      },
    })
    const container = mountPanel("session:plugin-ui")
    const panel = createElement(UtilityPanel, {
      scopeId: "session:plugin-ui",
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
    })
    await act(async () =>
      mountedRoot!.render(
        createElement(PluginUiProvider, {
          onOpenSidebar: () => {},
          children: [
            createElement(PluginUiCard, {
              key: "card",
              instance: actualInstance,
              call: actualPart,
            }),
            createElement("div", { key: "panel" }, panel),
          ],
        })
      )
    )
    expect(utilityToolOrder).not.toContain("plugin-ui")
    expect(container.querySelector("iframe")).toBeNull()
    await act(async () => {
      const button = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "在侧栏打开"
      )
      button!.click()
    })
    await settle()
    expect(container.querySelector("aside iframe")).not.toBeNull()
    expect(container.querySelector(".utility-tab-strip")?.textContent).toContain("检查结果")
    await act(async () =>
      (container.querySelector('button[aria-label="关闭标签"]') as HTMLButtonElement).click()
    )
    expect(container.querySelector("iframe")).toBeNull()
    expect(unmount).toHaveBeenCalledTimes(1)
    expect(dismiss).not.toHaveBeenCalled()
  })
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
