// @vitest-environment jsdom

import { act, createElement } from "react"
import type * as React from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopSessionPart, DesktopSessionView } from "@shared/session-types"

import { resetWorkspaceGitProbeCacheForTests } from "@renderer/lib/workspace-git-probe"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { emptySessionView } from "@renderer/stores/desktop-session/store-test-fixtures"

vi.mock("@renderer/components/desktop/tools/review/review-tool", async () => {
  const { createElement: h } = await import("react")
  return { ReviewTool: () => h("div", { "data-testid": "review-tool" }) }
})

vi.mock("@renderer/components/appearance/appearance-provider", () => ({
  useAppearance: () => ({ resolvedTheme: "light" }),
}))

import { UtilityPanel } from "../utility-panel"
import { PluginAppController } from "@renderer/components/desktop/shell/plugin-apps/controller"
import type { ResidentAppPage } from "@renderer/components/desktop/shell/plugin-apps/page-manager"
import { mount as appMount } from "@renderer/components/desktop/shell/plugin-apps/__test__/fixtures.test-support"
const appFixture = vi.hoisted(() => ({ pages: [] as ResidentAppPage[] }))
vi.mock("@renderer/components/desktop/shell/plugin-apps/provider", () => ({ usePluginApps: () => null, usePluginAppPages: () => appFixture.pages }))
import {
  readUtilityPanelRuntimeState,
  writeUtilityPanelRuntimeState,
} from "../utility-panel-repository"
import { defaultUtilityPanelRuntimeState } from "../use-utility-panel-runtime"
import { useCodePreviewDrafts } from "@renderer/components/desktop/tools/editor/code-preview-drafts"
import { imageSourceKey } from "@renderer/components/desktop/image-viewer/image-source"

// 图片编辑器自身另有集成测试；这里验证真实 panel 的标签和会话缓存。
vi.mock("@renderer/components/desktop/image-viewer/image-viewer-panel", () => ({
  ImageViewerPanel: () => null,
}))

const initialStoreState = useDesktopSessionStore.getState()
const panelMetrics = vi.hoisted(() => ({ renders: 0 }))
vi.mock("../use-utility-panel-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../use-utility-panel-runtime")>()
  return {
    ...actual,
    useUtilityPanelRuntime(scopeId: string) {
      panelMetrics.renders++
      return actual.useUtilityPanelRuntime(scopeId)
    },
  }
})
vi.hoisted(() => {
  // Importing the native terminal probes Canvas; this suite does not use a terminal.
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext
})
let mountedRoot: Root | null = null
let mountedContainer: HTMLDivElement | null = null

it.each([1000, 10000])(
  "keeps the utility panel idle during 20 text updates across %i historical parts",
  async (count) => {
    let metadataReads = 0
    const view = emptySessionView("panel-stream")
    view.session.status = "running"
    view.parts = Array.from({ length: count }, (_, index): DesktopSessionPart => ({
      id: `history-${index}`,
      sessionId: view.session.id,
      messageId: `message-${index}`,
      seq: index,
      type: "text",
      status: "completed",
      text: "历史消息",
      get metadata() {
        metadataReads++
        return {}
      },
      createdAt: 1,
      updatedAt: 1,
    }))
    const tail: DesktopSessionPart = {
      id: "tail",
      sessionId: view.session.id,
      messageId: "reply",
      seq: count,
      type: "text",
      status: "running",
      text: "",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    view.parts.push(tail)
    useDesktopSessionStore.setState({
      activeSessionId: view.session.id,
      sessionView: view,
      selectedProject: null,
    })
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {},
    })
    mountedContainer = document.createElement("div")
    document.body.append(mountedContainer)
    mountedRoot = createRoot(mountedContainer)
    await act(async () =>
      mountedRoot!.render(
          <UtilityPanel
            scopeId={`session:panel-perf-${count}`}
            open
            maximized={false}
            onToggleMaximized={() => {}}
            onClose={() => {}}
            fileOpenRequest={null}
            reviewOpenRequest={null}
            terminalOpenRequest={null}
            toolOpenRequest={null}
            onOpenFile={() => {}}
            onOpenReview={() => {}}
            onOpenTerminal={() => {}}
          />
      )
    )
    await settle()
    const focusedAction = mountedContainer.querySelector<HTMLButtonElement>("button")!
    focusedAction.focus()
    metadataReads = 0
    panelMetrics.renders = 0
    const start = performance.now()
    for (let index = 1; index <= 20; index++) {
      await act(async () =>
        useDesktopSessionStore.setState({
          sessionView: {
            ...view,
            cursor: index,
            parts: [...view.parts.slice(0, -1), { ...tail, text: "新增".repeat(index) }],
          },
        })
      )
    }
    console.info(
      JSON.stringify({
        scenario: "panel-text-stream",
        history: count,
        updates: 20,
        metadataReads,
        renders: panelMetrics.renders,
        elapsedMs: performance.now() - start,
      })
    )
    expect(metadataReads).toBe(0)
    expect(panelMetrics.renders).toBe(0)
    expect(document.activeElement).toBe(focusedAction)
  }
)

beforeEach(() => {
  appFixture.pages = []
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
  vi.unstubAllGlobals()
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
  it("opens outside HTML in a browser tab without opening a file viewer", async () => {
    installProbe(async () => ({ isRepository: false, rootPath: null }))
    Object.assign(window.desktop, { browser: { updateTab: vi.fn().mockResolvedValue(undefined) } })
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    useOutsideProjectSession("D:/plain-dir")
    const scopeId = "session:outside-html"
    mountPanel(scopeId, { fileOpenRequest: {
      id: 1, path: "C:/Users/ruanz/.answer-me-with-html/pages/report.html",
    } })
    await settle()
    const state = readUtilityPanelRuntimeState(scopeId)!
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({ tool: "browser", title: "report.html" })
    expect(state.activeTabId).toBe(state.tabs[0].id)
    expect(state.browserTabs[0].url).toBe("file:///C:/Users/ruanz/.answer-me-with-html/pages/report.html")
  })
  it.each(["cancel", "discard", "save", "failure"])(
    "protects an inactive dirty file on close: %s",
    async (action) => {
      installProbe(async () => ({ isRepository: false, rootPath: null }))
      const projectPath = "D:/plain-dir"
      useOutsideProjectSession(projectPath)
      const scopeId = `session:dirty-close-${action}`
      const key = JSON.stringify([scopeId, projectPath, "a.ts"])
      const preview = {
        path: "a.ts",
        name: "a.ts",
        language: "typescript",
        content: "original",
        size: 8,
        binary: false,
        scope: "project" as const,
        relativePath: "a.ts",
        rootLabel: "project",
        previewBytes: null,
        mediaType: null,
        imagePreviewError: null,
      }
      const writeFile = vi.fn(async () => ({ ...preview, content: "draft" }))
      if (action === "failure") writeFile.mockRejectedValue(new Error("文件已被其他程序修改"))
      Object.assign(window.desktop, { workspace: { writeFile } })
      writeUtilityPanelRuntimeState(scopeId, {
        ...defaultUtilityPanelRuntimeState(),
        tabs: [
          {
            id: "image",
            tool: "image",
            title: "image.png",
            imageSource: { kind: "attachment", assetId: "image", name: "image.png" },
          },
          { id: "file", tool: "files", title: "a.ts", filePath: "a.ts", projectPath },
        ],
        fileTabs: [{ preview, type: "code", projectPath }],
        fileProjectPath: projectPath,
        activeFilePath: "a.ts",
        activeTabId: "image",
      })
      useCodePreviewDrafts.getState().begin(key, "original", preview)
      useCodePreviewDrafts.getState().change(key, "draft")
      const container = mountPanel(scopeId)
      await settle()
      expect(container.querySelector('[aria-label="未保存"]')).not.toBeNull()
      // 文件 tab 与文件树复用同一套 SVG 图标。
      expect(container.querySelector('button[title="a.ts"] use')?.getAttribute("href")).toContain(
        "vykor-tree-icons-"
      )
      await act(async () =>
        container.querySelectorAll<HTMLButtonElement>('button[aria-label="关闭标签"]')[1]!.click()
      )
      await settle()
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
        "保存文件修改？"
      )
      const label = action === "cancel" ? "取消" : action === "discard" ? "不保存" : "保存"
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
      ].find((button) => button.textContent === label)!
      await act(async () => button.click())
      await settle()
      const kept = action === "cancel" || action === "failure"
      expect(readUtilityPanelRuntimeState(scopeId)?.tabs.some((tab) => tab.id === "file")).toBe(
        kept
      )
      expect(useCodePreviewDrafts.getState().drafts[key]?.content).toBe(kept ? "draft" : undefined)
      if (action === "save" || action === "failure")
        expect(writeFile).toHaveBeenCalledWith({
          rootPath: projectPath,
          path: "a.ts",
          originalContent: "original",
          content: "draft",
        })
      else expect(writeFile).not.toHaveBeenCalled()
      if (action === "failure")
        expect(document.querySelector('[role="alert"]')?.textContent).toContain("已被其他程序修改")
      await act(async () => useCodePreviewDrafts.getState().discard(key))
    }
  )
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

it.each([
  { modes: undefined }, { modes: [] }, { modes: ["inline"] }, { modes: ["fullscreen"] }, { modes: ["inline", "fullscreen"] },
] as const)("keeps current-session application tabs reachable with display modes $modes", async ({ modes }) => {
  useDesktopSessionStore.setState({ activeSessionId: "original", sessionView: emptySessionView("original"), selectedProject: null })
  Object.defineProperty(window, "desktop", { configurable: true, value: {} })
  const foreignMount = { ...appMount, state: { ...appMount.state, source: { ...appMount.state.source, sessionId: "another" } } }
  appFixture.pages = [
    { id: "mount", title: "MODE_ELIGIBILITY_APP", controller: new PluginAppController(appMount, {} as never, async () => false), modes: modes ? [...modes] : undefined },
    { id: "foreign", title: "FOREIGN_SESSION_APP", controller: new PluginAppController(foreignMount, {} as never, async () => false), modes: ["inline"] },
  ]
  const container = mountPanel("session:mode-eligibility")
  await settle()
  expect(container.textContent).toContain("MODE_ELIGIBILITY_APP")
  expect(container.textContent).not.toContain("FOREIGN_SESSION_APP")
})
