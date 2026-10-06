// @vitest-environment jsdom
import { act, useState } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
const appearance = vi.hoisted(() => ({ theme: "light" }))
vi.mock("@renderer/components/appearance/appearance-provider", () => ({
  useAppearance: () => ({ resolvedTheme: appearance.theme }),
}))
import { BrowserTool, type BrowserToolTab } from "./browser-tool"

it("clears loading after the empty tab's internal blank page finishes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const updateTab = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { browser: { updateTab } },
  })
  const element = document.createElement("div"),
    root = createRoot(element)
  function Harness() {
    const [tab, setTab] = useState<BrowserToolTab>({
      id: "blank-tab",
      title: "新标签页",
      url: null,
      input: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    })
    return (
      <BrowserTool
        tab={tab}
        active
        visible={false}
        onUpdate={(patch) => setTab((current) => ({ ...current, ...patch }))}
      />
    )
  }
  try {
    await act(async () => root.render(<Harness />))
    const webview = element.querySelector("webview")!
    Object.assign(webview, { getURL: () => "about:blank", getTitle: () => "about:blank" })
    await act(async () => {
      webview.dispatchEvent(new Event("did-start-loading"))
    })
    expect(
      element.querySelector('[aria-label="停止加载"] svg')?.classList.contains("animate-spin")
    ).toBe(true)
    await act(async () => {
      webview.dispatchEvent(new Event("did-stop-loading"))
    })
    expect(element.querySelector('[aria-label="停止加载"]')).toBeNull()
    expect(
      element.querySelector('[aria-label="刷新"] svg')?.classList.contains("animate-spin")
    ).toBe(false)
    expect(element.querySelector<HTMLInputElement>('[aria-label="浏览器地址"]')?.value).toBe("")
    expect(element.textContent).toContain("开始浏览")
    expect(webview.getAttribute("src")).toBe("about:blank")
  } finally {
    await act(async () => root.unmount())
    Reflect.deleteProperty(window, "desktop")
    vi.unstubAllGlobals()
  }
})

it("does not unbind a live webview when only the application theme changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const updateTab = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { browser: { updateTab } },
  })
  const element = document.createElement("div"),
    root = createRoot(element)
  const tab = {
    id: "tab-1",
    title: "页面",
    url: "http://localhost",
    input: "http://localhost",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  }
  const render = () =>
    root.render(<BrowserTool tab={tab} active visible={false} onUpdate={() => {}} />)
  try {
    await act(async () => {
      render()
    })
    const webview = element.querySelector("webview")!
    Object.assign(webview, { getWebContentsId: () => 42, insertCSS: async () => "style" })
    await act(async () => {
      webview.dispatchEvent(new Event("dom-ready"))
    })
    updateTab.mockClear()
    appearance.theme = "dark"
    await act(async () => {
      render()
    })
    expect(element.querySelector("webview")).toBe(webview)
    expect(updateTab.mock.calls.some(([input]) => input.action === "unbind")).toBe(false)
  } finally {
    await act(async () => root.unmount())
    appearance.theme = "light"
    Reflect.deleteProperty(window, "desktop")
    vi.unstubAllGlobals()
  }
})
