// @vitest-environment jsdom
import { act, startTransition, StrictMode, Suspense } from "react"
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
let finishSave: ((snapshot: BrowserAnnotationSnapshot) => void) | undefined
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
  vi.stubGlobal("ResizeObserver", class { observe = vi.fn(); disconnect = vi.fn() })
  resetDesktopSessionStore()
  Object.defineProperty(window, "desktop", { configurable: true, value: { browser: {
    updateTab: async () => {}, readAnnotations: async () => locked, setAnnotationMode: async () => locked,
    addAnnotation: () => new Promise<BrowserAnnotationSnapshot>(resolve => { finishSave = resolve }),
  } } })
  host = document.createElement("div"); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.useRealTimers()
  host.remove(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "desktop")
})

it("uses browser container breakpoints for the annotation toolbar action", async () => {
  await act(async () => render("session:first"))
  const button = host.querySelector<HTMLButtonElement>('[aria-label="选择页面元素添加批注"]')!
  expect(button.className).toContain("@[28rem]/browser:inline-flex")
  expect(button.className).toContain("hidden")
  const label = button.querySelector("span")!
  expect(label.textContent).toBe("批注")
  expect(label.className).toContain("@[44rem]/browser:inline")
})

const blockedRender = new Promise<void>(() => {})
function SuspendRender({ blocked }: { blocked: boolean }) {
  if (blocked) throw blockedRender
  return null
}

function render(composerScope: string, blocked = false) {
  root.render(
    <StrictMode>
      <Suspense fallback={<p>切换中</p>}>
        <BrowserTool tab={tab} composerScope={composerScope} active visible onUpdate={() => {}} />
        <SuspendRender blocked={blocked} />
      </Suspense>
    </StrictMode>
  )
}

async function mountBrowser(composerScope: string) {
  await act(async () => render(composerScope))
  const webview = host.querySelector("webview")!
  Object.assign(webview, { getURL: () => tab.url, getTitle: () => tab.title, insertCSS: async () => "style" })
  await act(async () => {
    webview.dispatchEvent(new Event("dom-ready"))
    webview.dispatchEvent(new Event("did-stop-loading"))
  })
}

async function beginSave(composerScope: string) {
  finishSave = undefined
  await mountBrowser(composerScope)
  const input = host.querySelector("textarea")!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, record.comment)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => {
    input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  })
  expect(finishSave).toBeTypeOf("function")
}

async function completeSave() {
  await act(async () => { finishSave!({ ...locked, selection: null, annotations: [{ record, status: "visible", rect: null }] }) })
}

it.each([
  { originalScope: "new-conversation", rerender: true },
  { originalScope: "session:first", rerender: true },
  { originalScope: "new-conversation", rerender: false },
])(
  "keeps a late browser save out of the next composer after leaving $originalScope (rerender=$rerender)",
  async ({ originalScope, rerender }) => {
    useDesktopSessionStore.getState().setComposerDraftText(originalScope, "原草稿")
    await beginSave(originalScope)
    if (originalScope === "new-conversation") {
      await act(async () => {
        useDesktopSessionStore.getState().migrateComposerDraft(originalScope, "session:created")
        useDesktopSessionStore.setState({ activeSessionId: "created" })
      })
    }
    if (rerender) await act(async () => render("session:next"))
    await completeSave()

    const drafts = useDesktopSessionStore.getState().composerDraftsByScope
    expect(drafts["session:next"]).toBeUndefined()
    if (originalScope === "new-conversation") expect(drafts[originalScope]).toBeUndefined()
    else expect(drafts[originalScope]?.browserAnnotations).toEqual([record])
  }
)

it("keeps a save in the committed composer while a different scope render is suspended", async () => {
  await beginSave("new-conversation")
  await act(async () => { startTransition(() => render("session:next", true)) })
  expect(host.textContent).not.toContain("切换中")
  await completeSave()
  expect(useDesktopSessionStore.getState().composerDraftsByScope["new-conversation"]?.browserAnnotations).toEqual([record])
  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:next"]).toBeUndefined()
})

it.each(["draft migration", "session change"])("rejects an old new-composer save after %s without a scope commit", async change => {
  vi.useFakeTimers()
  useDesktopSessionStore.getState().setComposerDraftText("new-conversation", "原草稿")
  await beginSave("new-conversation")
  await act(async () => {
    if (change === "draft migration")
      useDesktopSessionStore.getState().migrateComposerDraft("new-conversation", "session:created")
    else {
      useDesktopSessionStore.setState({ activeSessionId: "created" })
      useDesktopSessionStore.setState({ activeSessionId: null })
    }
  })
  await completeSave()
  const drafts = useDesktopSessionStore.getState().composerDraftsByScope
  expect(drafts["new-conversation"]?.browserAnnotations).toBeUndefined()
  if (change === "draft migration") expect(drafts["new-conversation"]).toBeUndefined()
  expect(useDesktopSessionStore.getState().composerDraftsByScope["session:created"]?.browserAnnotations).toBeUndefined()

  // 拒绝旧请求后，下一份新聊天草稿仍然可以正常接收新保存。
  window.desktop.browser.readAnnotations = async () => ({ ...locked, eventSequence: 2 })
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  await beginSave("new-conversation")
  await completeSave()
  expect(useDesktopSessionStore.getState().composerDraftsByScope["new-conversation"]?.browserAnnotations).toEqual([record])
})

it("does not revive a new composer after leaving its scope and coming back", async () => {
  await beginSave("new-conversation")
  await act(async () => render("session:next"))
  await act(async () => render("new-conversation"))
  await completeSave()
  expect(useDesktopSessionStore.getState().composerDraftsByScope["new-conversation"]).toBeUndefined()
})

it.each(["new-conversation", "session:first"])("keeps late saves owned by %s after unmount", async scope => {
  await beginSave(scope)
  await act(async () => root.render(null))
  await completeSave()
  const annotations = useDesktopSessionStore.getState().composerDraftsByScope[scope]?.browserAnnotations
  expect(annotations).toEqual(scope === "new-conversation" ? undefined : [record])
})

it.each(["new-conversation", "session:first"])("keeps a late deletion owned by its original %s composer", async scope => {
  const saved: BrowserAnnotationSnapshot = { ...locked, selection: null, focusedAnnotationId: record.id,
    annotations: [{ record, status: "visible", rect: null }] }
  let finishRemove!: (snapshot: BrowserAnnotationSnapshot) => void
  window.desktop.browser.readAnnotations = async () => saved
  window.desktop.browser.removeAnnotation = () => new Promise(resolve => { finishRemove = resolve })
  useDesktopSessionStore.getState().putBrowserAnnotation(scope, record)
  await mountBrowser(scope)
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="删除批注 1"]')!.click())
  await act(async () => render("session:next"))
  if (scope === "new-conversation") {
    await act(async () => {
      useDesktopSessionStore.getState().resetComposerDraft(scope)
      useDesktopSessionStore.getState().putBrowserAnnotation(scope, { ...record, comment: "新聊天的意见" })
      render(scope)
    })
  }
  await act(async () => { finishRemove({ ...saved, focusedAnnotationId: null, annotations: [] }) })
  expect(useDesktopSessionStore.getState().composerDraftsByScope[scope]?.browserAnnotations).toEqual(
    scope === "new-conversation" ? [{ ...record, comment: "新聊天的意见" }] : []
  )
})
