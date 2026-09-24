import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createBrowserTab,
  defaultUtilityPanelViewState,
  parsePersistedFileTabs,
  parseUtilityPanelViewStates,
  shouldMoveDraftPanelToSession,
  utilityPanelScopeId,
} from "./utility-panel-state"
import {
  moveUtilityPanelScope,
  patchUtilityPanelViewState,
  readUtilityPanelRuntimeState,
  writeUtilityPanelRuntimeState,
} from "./utility-panel-repository"
import {
  defaultUtilityPanelRuntimeState,
  utilityPanelRuntimeReducer,
} from "./use-utility-panel-runtime"

describe("utility panel state", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("uses one scope per session and a separate draft scope per project", () => {
    expect(utilityPanelScopeId("session-1", "project-1")).toBe("session:session-1")
    expect(utilityPanelScopeId("session-2", "project-1")).toBe("session:session-2")
    expect(utilityPanelScopeId(null, "project-1")).toBe("draft:project-1")
    expect(utilityPanelScopeId(null, null)).toBe("draft:outside-project")
  })

  it("defaults new scopes to a collapsed panel", () => {
    expect(defaultUtilityPanelViewState()).toEqual({
      open: false,
      maximized: false,
      layout: null,
    })
  })

  it("creates a browser tab that immediately navigates to a requested local file", () => {
    expect(
      createBrowserTab("browser-tab-local", "file:///D:/demo/index.html", "index.html")
    ).toEqual({
      id: "browser-tab-local",
      title: "index.html",
      url: "file:///D:/demo/index.html",
      input: "file:///D:/demo/index.html",
      loading: true,
      canGoBack: false,
      canGoForward: false,
    })
  })

  it("patches one scope without changing another session", () => {
    const states = {
      "session:one": defaultUtilityPanelViewState(),
      "session:two": defaultUtilityPanelViewState(),
    }

    const nextStates = patchUtilityPanelViewState(states, "session:one", {
      open: true,
      layout: { conversation: 55, utility: 45 },
    })

    expect(nextStates["session:one"]).toEqual({
      open: true,
      maximized: false,
      layout: { conversation: 55, utility: 45 },
    })
    expect(nextStates["session:two"]).toBe(states["session:two"])
  })

  it("moves a draft only when it becomes a newly created session", () => {
    const knownSessionIds = new Set(["existing-session"])

    expect(shouldMoveDraftPanelToSession(null, "new-session", knownSessionIds)).toBe(true)
    expect(shouldMoveDraftPanelToSession(null, "existing-session", knownSessionIds)).toBe(false)
    expect(shouldMoveDraftPanelToSession("source-session", "fork-session", knownSessionIds)).toBe(
      false
    )
    expect(shouldMoveDraftPanelToSession("source-session", null, knownSessionIds)).toBe(false)
  })

  it("reads valid scoped states and rejects invalid layouts", () => {
    expect(
      parseUtilityPanelViewStates(
        JSON.stringify({
          "session:one": {
            open: true,
            maximized: true,
            layout: { conversation: 45, utility: 55 },
          },
          "session:two": {
            open: false,
            maximized: true,
            layout: { conversation: 100, utility: 0 },
          },
        })
      )
    ).toEqual({
      "session:one": {
        open: true,
        maximized: true,
        layout: { conversation: 45, utility: 55 },
      },
      "session:two": {
        open: false,
        maximized: false,
        layout: null,
      },
    })
  })

  it("parses persisted file tabs without trusting malformed entries", () => {
    expect(
      parsePersistedFileTabs(
        JSON.stringify({
          "session:one": { activePath: "README.md", paths: ["README.md", 42] },
          "session:empty": { activePath: null, paths: [] },
          invalid: "not-an-object",
        })
      )
    ).toEqual({
      "session:one": { activePath: "README.md", paths: ["README.md"] },
    })
  })

  it("moves a draft runtime instance into a newly created session", () => {
    const draftScope = "draft:test-runtime-move"
    const sessionScope = "session:test-runtime-move"
    const state = {
      tabs: [],
      browserTabs: [],
      fileTabs: [],
      fileProjectPath: null,
      activeFilePath: null,
      loadingFilePath: null,
      activeTabId: "terminal-tab:one",
      terminalMounted: true,
      handledFileRequestId: null,
      handledToolRequestId: null,
    }
    const persisted = new Map<string, string>([
      [
        "vykor.desktop.file-tabs",
        JSON.stringify({ [draftScope]: { activePath: "README.md", paths: ["README.md"] } }),
      ],
    ])
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => persisted.get(key) ?? null,
      setItem: (key: string, value: string) => persisted.set(key, value),
    })

    writeUtilityPanelRuntimeState(draftScope, state)
    moveUtilityPanelScope(draftScope, sessionScope, {})

    expect(readUtilityPanelRuntimeState(draftScope)).toBeUndefined()
    expect(readUtilityPanelRuntimeState(sessionScope)).toBe(state)
    expect(JSON.parse(persisted.get("vykor.desktop.file-tabs") ?? "{}")).toEqual({
      [sessionScope]: { activePath: "README.md", paths: ["README.md"] },
    })
  })

  it("updates the cached runtime snapshot through reducer actions", () => {
    const initialState = defaultUtilityPanelRuntimeState()
    const withTab = utilityPanelRuntimeReducer(initialState, {
      type: "tabs",
      value: (tabs) => [...tabs, { id: "files-tab", tool: "files", title: "文件" }],
    })
    const handled = utilityPanelRuntimeReducer(withTab, {
      type: "handledFileRequestId",
      value: 42,
    })

    expect(handled.tabs).toEqual([{ id: "files-tab", tool: "files", title: "文件" }])
    expect(handled.handledFileRequestId).toBe(42)
    expect(initialState.tabs).toEqual([])
  })
})
