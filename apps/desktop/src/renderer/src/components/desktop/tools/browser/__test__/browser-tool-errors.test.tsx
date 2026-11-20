// @vitest-environment jsdom
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { BrowserTool, type BrowserToolTab } from "../browser-tool"

vi.mock("@renderer/components/appearance/appearance-provider", () => ({
  useAppearance: () => ({ resolvedTheme: "light" }),
}))

let host: HTMLDivElement
let root: Root
let currentUrl: string | null
const reload = vi.fn()
const loadURL = vi.fn().mockResolvedValue(undefined)
const goBack = vi.fn()
const updates = vi.fn()
const missingFile = "file:///C:/reports/%E6%8A%A5%E5%91%8A.html"

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  vi.clearAllMocks()
  currentUrl = "https://example.com/"
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      browser: {
        updateTab: vi.fn().mockResolvedValue(undefined),
        readAnnotations: vi.fn().mockResolvedValue({ ready: false, annotations: [] }),
        setAnnotationMode: vi.fn().mockResolvedValue(undefined),
      },
    },
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, "desktop")
})

function Harness() {
  const [tab, setTab] = useState<BrowserToolTab>({
    id: "error-page",
    title: "测试页面",
    url: currentUrl,
    input: currentUrl ?? "",
    loading: false,
    canGoBack: true,
    canGoForward: false,
  })
  return (
    <BrowserTool
      tab={tab}
      composerScope="session:errors"
      active
      visible
      onUpdate={(patch) => {
        updates(patch)
        setTab((value) => ({ ...value, ...patch }))
      }}
    />
  )
}

async function mount() {
  await act(async () => root.render(<Harness />))
  const webview = host.querySelector("webview")!
  Object.assign(webview, {
    getURL: () => currentUrl ?? "about:blank",
    getTitle: () => "测试页面",
    getWebContentsId: () => 42,
    insertCSS: vi.fn().mockResolvedValue("style"),
    canGoBack: () => true,
    canGoForward: () => false,
    reload,
    loadURL,
    goBack,
  })
  return webview
}

async function emit(webview: Element, name: string, fields: Record<string, unknown> = {}) {
  const event = new Event(name)
  Object.assign(event, fields)
  await act(async () => {
    webview.dispatchEvent(event)
  })
}

const failure = () => host.querySelector('[role="alert"][aria-label="浏览器加载失败"]')
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
const failLoad = (webview: Element, overrides = {}) =>
  emit(webview, "did-fail-load", {
    isMainFrame: true,
    errorCode: -6,
    errorDescription: "ERR_FILE_NOT_FOUND",
    validatedURL: currentUrl,
    ...overrides,
  })

it("explains missing local files, keeps the failed address, and survives the final loading events", async () => {
  currentUrl = missingFile
  const webview = await mount()
  await failLoad(webview)
  // Chromium may expose its internal error document or the previous address after failure.
  currentUrl = "about:blank"
  await emit(webview, "dom-ready")
  await emit(webview, "did-stop-loading")
  expect(failure()?.textContent).toContain("找不到本地文件")
  expect(failure()?.textContent).toContain("报告.html")
  expect(failure()?.textContent).toContain("ERR_FILE_NOT_FOUND")
  expect(failure()?.textContent).not.toContain("检查网络")
  expect(host.querySelector<HTMLInputElement>('[aria-label="浏览器地址"]')?.value).toContain(
    "%E6%8A%A5%E5%91%8A.html"
  )
  expect(button("截图").disabled).toBe(true)
  expect(button("选择页面元素添加批注").disabled).toBe(true)
})

it.each([
  [-106, "ERR_INTERNET_DISCONNECTED", "网络已断开"],
  [-105, "ERR_NAME_NOT_RESOLVED", "找不到这个网站"],
  [-102, "ERR_CONNECTION_REFUSED", "连接被拒绝"],
  [-118, "ERR_CONNECTION_TIMED_OUT", "连接超时"],
  [-202, "ERR_CERT_AUTHORITY_INVALID", "无法建立安全连接"],
  [-130, "ERR_PROXY_CONNECTION_FAILED", "无法连接代理服务"],
] as const)("describes %s / %s", async (errorCode, errorDescription, title) => {
  const webview = await mount()
  await failLoad(webview, { errorCode, errorDescription })
  expect(failure()?.textContent).toContain(title)
  expect(failure()?.textContent).toContain(errorDescription)
})

it.each([404, 403, 429, 500, 503])(
  "shows HTTP %s only for the main document and can reveal the original response",
  async (httpResponseCode) => {
    const webview = await mount()
    await emit(webview, "did-frame-navigate", {
      url: currentUrl,
      httpResponseCode,
      isMainFrame: false,
    })
    expect(failure()).toBeNull()
    await emit(webview, "did-frame-navigate", {
      url: currentUrl,
      httpResponseCode,
      isMainFrame: true,
    })
    await emit(webview, "did-stop-loading")
    expect(failure()?.textContent).toContain(`HTTP ${httpResponseCode}`)
    expect(host.querySelector("webview")).toBe(webview)
    await act(async () => button("查看原网页").click())
    expect(failure()).toBeNull()
    expect(webview.getAttribute("src")).toBe(currentUrl)
    expect(reload).not.toHaveBeenCalled()
    expect(loadURL).not.toHaveBeenCalled()
    expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({ title: "测试页面" }))
    await emit(webview, "did-stop-loading")
    expect(failure()).toBeNull()
  }
)

it("ignores cancelled navigations and iframe failures", async () => {
  const webview = await mount()
  await failLoad(webview, { isMainFrame: false })
  expect(failure()).toBeNull()
  await failLoad(webview, { errorCode: -3, errorDescription: "ERR_ABORTED" })
  expect(failure()).toBeNull()
})

it("retries the failed target and recovers when a later main navigation succeeds", async () => {
  const webview = await mount()
  await failLoad(webview)
  expect(failure()).not.toBeNull()
  const failedUrl = currentUrl
  currentUrl = "https://example.com/previous"
  await act(async () => button("重新加载页面").click())
  expect(loadURL).toHaveBeenCalledExactlyOnceWith(failedUrl)
  currentUrl = failedUrl
  await emit(webview, "did-start-navigation", {
    url: currentUrl,
    isMainFrame: true,
    isInPlace: false,
  })
  expect(failure()).toBeNull()
  await emit(webview, "did-frame-navigate", {
    url: currentUrl,
    isMainFrame: true,
    httpResponseCode: 200,
  })
  await emit(webview, "dom-ready")
  await emit(webview, "did-stop-loading")
  expect(button("截图").disabled).toBe(false)
})

it("returns to the previous page and handles renderer crashes", async () => {
  const webview = await mount()
  await emit(webview, "render-process-gone", { details: { reason: "crashed", exitCode: 1 } })
  expect(failure()?.textContent).toContain("页面意外退出")
  await act(async () => button("返回上一页").click())
  expect(goBack).toHaveBeenCalledOnce()
})

it("ignores late failures from a previous navigation, including after a redirect", async () => {
  const webview = await mount()
  const previous = currentUrl
  currentUrl = "https://example.com/new"
  await emit(webview, "did-start-navigation", {
    url: currentUrl,
    isMainFrame: true,
    isInPlace: false,
  })
  await failLoad(webview, { validatedURL: previous })
  expect(failure()).toBeNull()
  currentUrl = "https://example.com/final"
  await emit(webview, "did-redirect-navigation", {
    url: currentUrl,
    isMainFrame: true,
    isInPlace: false,
  })
  await failLoad(webview, { errorCode: -105, errorDescription: "ERR_NAME_NOT_RESOLVED" })
  expect(failure()?.textContent).toContain("找不到这个网站")
})

it("keeps an existing failure during subframe navigation and resource loading", async () => {
  const webview = await mount()
  await failLoad(webview)
  await emit(webview, "did-start-navigation", {
    url: "https://example.com/frame",
    isMainFrame: false,
    isInPlace: false,
  })
  await emit(webview, "did-start-loading")
  await emit(webview, "did-stop-loading")
  expect(failure()?.textContent).toContain("ERR_FILE_NOT_FOUND")
  expect(button("截图").disabled).toBe(true)
})

it("detaches old webview listeners before another page is mounted", async () => {
  const previous = await mount()
  await act(async () => root.render(null))
  currentUrl = "https://example.com/new"
  const current = await mount()
  expect(current).not.toBe(previous)
  await failLoad(previous, { validatedURL: "https://example.com/old" })
  expect(failure()).toBeNull()
})

it("handles a main-frame failure before the webview is ready", async () => {
  const webview = await mount()
  Object.assign(webview, {
    getTitle: () => { throw new Error("webview not ready") },
    canGoBack: () => { throw new Error("webview not ready") },
    canGoForward: () => { throw new Error("webview not ready") },
  })
  const errors: unknown[] = []
  const onError = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault() }
  window.addEventListener("error", onError)
  try {
    await emit(webview, "did-start-loading")
    await failLoad(webview)
    expect(errors).toEqual([])
    expect(failure()?.textContent).toContain("ERR_FILE_NOT_FOUND")
    expect(host.querySelector('[aria-label="停止加载"]')).toBeNull()
    loadURL.mockImplementationOnce(() => { throw new Error("webview not ready") })
    const setAttribute = vi.spyOn(webview, "setAttribute")
    await act(async () => button("重新加载页面").click())
    expect(errors).toEqual([])
    expect(setAttribute).toHaveBeenCalledWith("src", currentUrl)
  } finally {
    window.removeEventListener("error", onError)
  }
})

it("restores an already loaded document after the next navigation is stopped", async () => {
  const webview = await mount()
  await emit(webview, "dom-ready")
  await emit(webview, "did-stop-loading")
  expect(button("截图").disabled).toBe(false)
  const next = "https://example.com/next"
  await emit(webview, "did-start-navigation", { url: next, isMainFrame: true, isInPlace: false })
  await emit(webview, "did-start-loading")
  await failLoad(webview, { validatedURL: next, errorCode: -3, errorDescription: "ERR_ABORTED" })
  await emit(webview, "did-stop-loading")
  expect(failure()).toBeNull()
  expect(button("截图").disabled).toBe(false)
})

it("restores the previous failure when its retry is stopped before a new document commits", async () => {
  const webview = await mount()
  await failLoad(webview)
  await act(async () => button("重新加载页面").click())
  await emit(webview, "did-start-navigation", {
    url: currentUrl,
    isMainFrame: true,
    isInPlace: false,
  })
  await failLoad(webview, { errorCode: -3, errorDescription: "ERR_ABORTED" })
  await emit(webview, "did-stop-loading")
  expect(failure()?.textContent).toContain("ERR_FILE_NOT_FOUND")
})

it.each(["file://%", "javascript:alert(1)"])(
  "explains %s without passing raw invalid input to a retry",
  async (inputValue) => {
    await mount()
    const input = host.querySelector<HTMLInputElement>('[aria-label="浏览器地址"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        inputValue
      )
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const errors: unknown[] = []
    const onError = (event: ErrorEvent) => {
      errors.push(event.error)
      event.preventDefault()
    }
    window.addEventListener("error", onError)
    try {
      await act(async () =>
        input
          .closest("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      )
      expect(errors).toEqual([])
      expect(failure()?.textContent).toContain("无法识别这个地址")
      expect(input.value).toBe(inputValue)
      expect(button("在浏览器中打开").disabled).toBe(true)
      await act(async () => button("重新加载页面").click())
      expect(errors).toEqual([])
      expect(loadURL).not.toHaveBeenCalled()
      expect(host.querySelector("webview")?.getAttribute("src")).toBe("https://example.com/")
    } finally {
      window.removeEventListener("error", onError)
    }
  }
)

it("does not crash a blank tab while an invalid file address is being typed", async () => {
  currentUrl = null
  await mount()
  const input = host.querySelector<HTMLInputElement>('[aria-label="浏览器地址"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "file://%"
    )
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  expect(host.querySelector("webview")?.getAttribute("src")).toBe("about:blank")
  expect(button("在浏览器中打开").disabled).toBe(true)
  await act(async () =>
    input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  )
  expect(failure()?.textContent).toContain("无法识别这个地址")
})

it("recovers after a repeated retry cancels an earlier attempt to the same address", async () => {
  const webview = await mount()
  await failLoad(webview)
  const navigation = { url: currentUrl, isMainFrame: true, isInPlace: false }
  await emit(webview, "did-start-navigation", navigation)
  await emit(webview, "did-start-navigation", navigation)
  await failLoad(webview, { errorCode: -3, errorDescription: "ERR_ABORTED" })
  await emit(webview, "did-frame-navigate", {
    url: currentUrl,
    isMainFrame: true,
    httpResponseCode: 200,
  })
  await emit(webview, "dom-ready")
  await emit(webview, "did-stop-loading")
  expect(failure()).toBeNull()
  expect(button("截图").disabled).toBe(false)
})
