// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { BrowserAnnotationSnapshot } from "@shared/browser-annotation"
import type { SessionUserInputItem } from "@shared/session-types"
import {
  readUtilityPanelRuntimeState,
  resetUtilityPanelRuntimeStatesForTests,
  writeUtilityPanelRuntimeState,
  writeUtilityPanelViewStates,
} from "@renderer/components/desktop/layout/main-layout/utility-panel/utility-panel-repository"
import { captureBrowserAnnotationContext, stripBrowserAnnotationContext } from "../browser-prompt-context"

const scopeId = "session:chat"
const pageUrl = "http://localhost:5173/design"
const snapshot: BrowserAnnotationSnapshot = {
  pageUrl, pageRevision: 2, ready: true, mode: "review",
  interactionVersion: 1, eventSequence: 1, selection: null, focusedAnnotationId: null, viewport: null,
  annotations: [{
    record: { id: "a-1", pageUrl, target: "button: 提交", selector: "#submit", comment: "增加按钮留白",
      locatorKind: "unique-id", tagName: "button", role: "button", name: "提交" },
    status: "missing", rect: null,
  }],
}
let readAnnotations: ReturnType<typeof vi.fn>

function openBrowser(): void {
  writeUtilityPanelViewStates({ [scopeId]: { open: true, maximized: false, layout: null } })
  writeUtilityPanelRuntimeState(scopeId, {
    tabs: [{ id: "browser-1", tool: "browser", title: "设计页面" }],
    browserTabs: [{ id: "browser-1", title: "设计页面", url: pageUrl, input: pageUrl,
      loading: false, canGoBack: false, canGoForward: false }],
    fileTabs: [], fileProjectPath: null, activeFilePath: null, loadingFilePath: null,
    activeTabId: "browser-1", terminalMounted: false, handledFileRequestId: null, handledToolRequestId: null,
  })
}

beforeEach(() => {
  localStorage.clear()
  resetUtilityPanelRuntimeStatesForTests()
  readAnnotations = vi.fn().mockResolvedValue(snapshot)
  Object.defineProperty(window, "desktop", { configurable: true, value: { browser: { readAnnotations } } })
})

afterEach(() => {
  localStorage.clear()
  resetUtilityPanelRuntimeStatesForTests()
  Reflect.deleteProperty(window, "desktop")
})

it.each(["empty", "closed", "non-browser", "missing-browser", "blank-url", "loading"])(
  "returns null synchronously when the scope has no readable current page: %s", reason => {
    if (reason !== "empty") {
      openBrowser()
      const state = readUtilityPanelRuntimeState(scopeId)!
      if (reason === "closed") writeUtilityPanelViewStates({})
      if (reason === "non-browser") state.tabs[0]!.tool = "files"
      if (reason === "missing-browser") state.browserTabs = []
      if (reason === "blank-url") state.browserTabs[0]!.url = "  "
      if (reason === "loading") state.browserTabs[0]!.loading = true
    }
    expect(captureBrowserAnnotationContext(scopeId)).toBeNull()
    expect(readAnnotations).not.toHaveBeenCalled()
  }
)

it("captures saved feedback with its URL and element selectors, including missing elements", async () => {
  openBrowser()
  const context = await captureBrowserAnnotationContext(scopeId)
  expect(readAnnotations).toHaveBeenCalledWith({ tabId: "browser-1" })
  expect(context).toContain("<browser_annotations>")
  const json = context!.split("<browser_annotations>\n")[1]!.split("\n</browser_annotations>")[0]!
  expect(JSON.parse(json)).toEqual({
    url: pageUrl,
    annotations: [{ target: "button: 提交", selector: "#submit", comment: "增加按钮留白" }],
  })
})

it("matches a bare origin with its root URL", async () => {
  openBrowser()
  readUtilityPanelRuntimeState(scopeId)!.browserTabs[0]!.url = "http://localhost:5173"
  readAnnotations.mockResolvedValue({ ...snapshot, pageUrl: "http://localhost:5173/" })
  expect(await captureBrowserAnnotationContext(scopeId)).toContain("<browser_annotations>")
})

it("does not match snapshots from a different path with a trailing slash", async () => {
  openBrowser()
  readAnnotations.mockResolvedValue({ ...snapshot, pageUrl: `${pageUrl}/` })
  expect(await captureBrowserAnnotationContext(scopeId)).toBeNull()
})

it("discards a pending read after navigation adds a path trailing slash", async () => {
  openBrowser()
  let finish!: (value: BrowserAnnotationSnapshot) => void
  readAnnotations.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const context = captureBrowserAnnotationContext(scopeId)
  readUtilityPanelRuntimeState(scopeId)!.browserTabs[0]!.url = `${pageUrl}/`
  finish(snapshot)
  expect(await context).toBeNull()
})

it.each([
  { ready: false }, { pageUrl: "http://localhost:5173/other" }, { annotations: [] },
])("omits snapshots without saved annotations for the current ready page: %j", async patch => {
  openBrowser()
  readAnnotations.mockResolvedValue({ ...snapshot, ...patch })
  expect(await captureBrowserAnnotationContext(scopeId)).toBeNull()
})

it.each(["closed", "tab", "url", "loading", "removed"])(
  "discards a read that finishes after the current page changes: %s", async reason => {
    openBrowser()
    let finish!: (value: BrowserAnnotationSnapshot) => void
    readAnnotations.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const context = captureBrowserAnnotationContext(scopeId)
    const state = readUtilityPanelRuntimeState(scopeId)!
    if (reason === "closed") writeUtilityPanelViewStates({})
    if (reason === "tab") state.activeTabId = "another-tab"
    if (reason === "url") state.browserTabs[0]!.url = "http://localhost:5173/other"
    if (reason === "loading") state.browserTabs[0]!.loading = true
    if (reason === "removed") resetUtilityPanelRuntimeStatesForTests()
    finish(snapshot)
    expect(await context).toBeNull()
  }
)

it("reports a read failure while the same page is still open", async () => {
  openBrowser()
  readAnnotations.mockRejectedValue(new Error("IPC disconnected"))
  await expect(captureBrowserAnnotationContext(scopeId)).rejects.toThrow(/读取.*批注.*失败/)
})

it("discards a read error after its browser page was closed", async () => {
  openBrowser()
  let fail!: (error: Error) => void
  readAnnotations.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject }))
  const context = captureBrowserAnnotationContext(scopeId)
  writeUtilityPanelViewStates({})
  fail(new Error("Unknown browser tab"))
  expect(await context).toBeNull()
})

it("escapes markup inside comments so it cannot close the annotation block", async () => {
  openBrowser()
  readAnnotations.mockResolvedValue({ ...snapshot, annotations: [{ ...snapshot.annotations[0],
    record: { ...snapshot.annotations[0]!.record, comment: "调整 <button>，保留 </browser_annotations>" } }] })
  const context = await captureBrowserAnnotationContext(scopeId)
  expect(context!.split("</browser_annotations>")).toHaveLength(2)
  expect(context).toContain("\\u003cbutton>")
})

const savedContext = '\n\n<browser_annotations>\n{"url":"http://localhost/design","annotations":[{"target":"按钮","selector":"#submit","comment":"增加留白"}]}\n</browser_annotations>'

it.each([true, false])("removes only the saved trailing block without mutating message items (merged=%s)", merged => {
  const original: SessionUserInputItem[] = merged
    ? [{ type: "text", text: `按批注修改${savedContext}` }]
    : [{ type: "text", text: "按批注修改" }, { type: "text", text: savedContext }]
  const before = structuredClone(original)
  expect(stripBrowserAnnotationContext(original)).toEqual([{ type: "text", text: "按批注修改" }])
  expect(original).toEqual(before)
})

it.each([
  `${savedContext}\n用户补充`,
  '\n\n<browser_annotations>\nnot json\n</browser_annotations>',
  '\n\n<browser_annotations>\n{"url":123,"annotations":[]}\n</browser_annotations>',
  '\n\n<browser_annotations>\n{"url":"http://localhost","annotations":{}}\n</browser_annotations>',
])("preserves text that is not a valid saved trailing context block: %s", text => {
  const items: SessionUserInputItem[] = [{ type: "text", text }]
  expect(stripBrowserAnnotationContext(items)).toEqual(items)
})

it("preserves annotation-looking text before a final non-text item", () => {
  const items: SessionUserInputItem[] = [
    { type: "text", text: savedContext }, { type: "mention", name: "file", path: "file.ts" },
  ]
  expect(stripBrowserAnnotationContext(items)).toEqual(items)
})

it("removes the original automatic block after the edit appends text and a mention", () => {
  const source: SessionUserInputItem[] = [{ type: "text", text: `原正文${savedContext}` }]
  const edited: SessionUserInputItem[] = [
    { type: "text", text: `新正文${savedContext}\n补充：保留图标` },
    { type: "mention", name: "file", path: "file.ts" },
  ]
  const beforeSource = structuredClone(source), beforeEdited = structuredClone(edited)
  expect(stripBrowserAnnotationContext(edited, source)).toEqual([
    { type: "text", text: "新正文\n补充：保留图标" },
    { type: "mention", name: "file", path: "file.ts" },
  ])
  expect(source).toEqual(beforeSource)
  expect(edited).toEqual(beforeEdited)
})

it("removes the exact source block only once, searching text items from the end", () => {
  const source: SessionUserInputItem[] = [{ type: "text", text: savedContext }]
  const edited: SessionUserInputItem[] = [
    { type: "text", text: `引用${savedContext}\n引用结束` },
    { type: "mention", name: "file", path: "file.ts" },
    { type: "text", text: savedContext },
    { type: "text", text: "新增要求" },
  ]
  expect(stripBrowserAnnotationContext(edited, source)).toEqual([
    { type: "text", text: `引用${savedContext}\n引用结束` },
    { type: "mention", name: "file", path: "file.ts" },
    { type: "text", text: "新增要求" },
  ])
})

it.each([
  "原正文",
  `原正文${savedContext}\n原消息自己的补充`,
  '\n\n<browser_annotations>\nnot json\n</browser_annotations>',
])("preserves a handwritten middle block when the source has no valid automatic suffix: %s", sourceText => {
  const edited: SessionUserInputItem[] = [{ type: "text", text: `正文${savedContext}\n补充` }]
  expect(stripBrowserAnnotationContext(edited, [{ type: "text", text: sourceText }])).toEqual(edited)
})

it("keeps the strict trailing-block fallback when the source has no automatic context", () => {
  const edited: SessionUserInputItem[] = [{ type: "text", text: `正文${savedContext}` }]
  expect(stripBrowserAnnotationContext(edited, [{ type: "text", text: "原正文" }])).toEqual([
    { type: "text", text: "正文" },
  ])
})
