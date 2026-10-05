// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
const appearance = vi.hoisted(() => ({ theme: "light" }))
vi.mock("@renderer/components/appearance/appearance-provider", () => ({ useAppearance: () => ({ resolvedTheme: appearance.theme }) }))
import { BrowserTool } from "./browser-tool"

it("does not unbind a live webview when only the application theme changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const updateTab = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, "desktop", { configurable: true, value: { browser: { updateTab } } })
  const element = document.createElement("div"), root = createRoot(element)
  const tab = { id: "tab-1", title: "页面", url: "http://localhost", input: "http://localhost", loading: false, canGoBack: false, canGoForward: false }
  const render = () => root.render(<BrowserTool tab={tab} active visible={false} onUpdate={() => {}} />)
  try {
    await act(async () => { render() })
    const webview = element.querySelector("webview")!
    Object.assign(webview, { getWebContentsId: () => 42, insertCSS: async () => "style" })
    await act(async () => { webview.dispatchEvent(new Event("dom-ready")) })
    updateTab.mockClear(); appearance.theme = "dark"
    await act(async () => { render() })
    expect(element.querySelector("webview")).toBe(webview)
    expect(updateTab.mock.calls.some(([input]) => input.action === "unbind")).toBe(false)
  } finally {
    await act(async () => root.unmount()); appearance.theme = "light"
    Reflect.deleteProperty(window, "desktop"); vi.unstubAllGlobals()
  }
})
