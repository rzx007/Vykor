// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { BrowserAnnotationSnapshot } from "@shared/browser-annotation"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { resetDesktopSessionStore } from "@renderer/stores/desktop-session/store-test-fixtures"

vi.mock("@renderer/components/appearance/appearance-provider", () => ({
  useAppearance: () => ({ resolvedTheme: "light" }),
}))
import { BrowserTool, type BrowserToolTab } from "../browser-tool"

let root: Root, host: HTMLDivElement
let finishSave: (snapshot: BrowserAnnotationSnapshot) => void
const tab: BrowserToolTab = { id: "tab-1", title: "页面", url: "https://example.com/", input: "https://example.com/", loading: false, canGoBack: false, canGoForward: false }
const locked: BrowserAnnotationSnapshot = {
  pageUrl: tab.url!, pageRevision: 1, ready: true, mode: "pick", interactionVersion: 1,
  eventSequence: 1, focusedAnnotationId: null, viewport: { width: 800, height: 600 }, annotations: [],
  selection: { selectionId: "selection", rect: { x: 10, y: 20, width: 80, height: 30 },
    target: { target: "button: 提交", selector: "#submit", locatorKind: "unique-id", tagName: "button", role: "button", name: "提交" } },
}
const record = { ...locked.selection!.target, id: "saved", pageUrl: tab.url!, comment: "增加间距" }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
  resetDesktopSessionStore()
  Object.defineProperty(window, "desktop", { configurable: true, value: { browser: {
    updateTab: async () => {}, readAnnotations: async () => locked, setAnnotationMode: async () => locked,
    addAnnotation: () => new Promise<BrowserAnnotationSnapshot>(resolve => { finishSave = resolve }),
  } } })
  host = document.createElement("div"); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "desktop")
})

it.each([
  { originalScope: "new-conversation", rerender: true },
  { originalScope: "session:first", rerender: true },
  { originalScope: "new-conversation", rerender: false },
])(
  "keeps a late browser save out of the next composer after leaving $originalScope (rerender=$rerender)",
  async ({ originalScope, rerender }) => {
    const render = (composerScope: string) => root.render(
      <BrowserTool tab={tab} composerScope={composerScope} active visible onUpdate={() => {}} />
    )
    useDesktopSessionStore.getState().setComposerDraftText(originalScope, "原草稿")
    await act(async () => render(originalScope))
    const webview = host.querySelector("webview")!
    Object.assign(webview, { getURL: () => tab.url, getTitle: () => tab.title, insertCSS: async () => "style" })
    await act(async () => {
      webview.dispatchEvent(new Event("dom-ready"))
      webview.dispatchEvent(new Event("did-stop-loading"))
    })
    const input = host.querySelector("textarea")!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, record.comment)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => {
      input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    })
    expect(finishSave).toBeTypeOf("function")
    if (originalScope === "new-conversation") {
      useDesktopSessionStore.getState().migrateComposerDraft(originalScope, "session:created")
      useDesktopSessionStore.setState({ activeSessionId: "created" })
    }
    if (rerender) await act(async () => render("session:next"))
    await act(async () => { finishSave({ ...locked, selection: null, annotations: [{ record, status: "visible", rect: null }] }) })

    const drafts = useDesktopSessionStore.getState().composerDraftsByScope
    expect(drafts["session:next"]).toBeUndefined()
    if (originalScope === "new-conversation") expect(drafts[originalScope]).toBeUndefined()
    else expect(drafts[originalScope]?.browserAnnotations).toEqual([record])
  }
)
