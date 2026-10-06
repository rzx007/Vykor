// @vitest-environment jsdom
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ImageViewerProvider } from "../image-viewer/image-viewer-provider"
import type { ImageSource } from "../image-viewer/image-source"
import type { BrowserAnnotationSnapshot } from "@shared/browser-annotation"

vi.mock("@renderer/components/appearance/appearance-provider", () => ({
  useAppearance: () => ({ resolvedTheme: "light" }),
}))
import { BrowserTool, type BrowserToolTab } from "./browser-tool"

let host: HTMLDivElement
let root: Root
let requests: ImageSource[]
let active: boolean
let initialUrl: string | null
let captures: number
const nativeImage = () => ({
  isEmpty: () => false,
  getSize: () => ({ width: 800, height: 600 }),
  // 模拟 PNG 来自一个较大缓冲区，不能把前后的无关字节送进批注。
  toPNG: () => new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4),
})
let capturePage: () => Promise<ReturnType<typeof nativeImage>>
let urls: Blob[]
let revoked: string[]

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        /* jsdom 不提供尺寸观察。 */
      }
      disconnect() {
        /* 没有注册原生观察器。 */
      }
    }
  )
  active = true
  initialUrl = "https://example.com/"
  captures = 0
  requests = []
  urls = []
  revoked = []
  capturePage = async () => {
    captures++
    return nativeImage()
  }
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL(blob: Blob) {
        urls.push(blob)
        return `blob:capture-${urls.length}`
      }
      static revokeObjectURL(url: string) {
        revoked.push(url)
      }
    }
  )
  const snapshot: BrowserAnnotationSnapshot = {
    pageUrl: "https://example.com/",
    pageRevision: 1,
    ready: true,
    mode: "off",
    interactionVersion: 0,
    eventSequence: 0,
    selection: null,
    focusedAnnotationId: null,
    viewport: { width: 800, height: 600 },
    annotations: [],
  }
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      browser: {
        updateTab: async () => {},
        readAnnotations: async () => snapshot,
        setAnnotationMode: async () => snapshot,
      },
    },
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  if (vi.isFakeTimers()) {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  }
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function Harness() {
  const [tab, setTab] = useState<BrowserToolTab>({
    id: "browser-1",
    title: "测试页面",
    url: initialUrl,
    input: initialUrl ?? "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  })
  return (
    <ImageViewerProvider onOpenImage={(source) => requests.push(source)}>
      <BrowserTool
        tab={tab}
        active={active}
        visible={active}
        onUpdate={(patch) => setTab((current) => ({ ...current, ...patch }))}
      />
    </ImageViewerProvider>
  )
}
async function mount(ready = true) {
  await act(async () => root.render(<Harness />))
  const webview = host.querySelector("webview")!
  Object.assign(webview, {
    getURL: () => initialUrl ?? "about:blank",
    getTitle: () => "测试页面",
    insertCSS: async () => "style",
    getWebContentsId: () => 42,
    capturePage: () => capturePage(),
  })
  if (ready)
    await act(async () => {
      webview.dispatchEvent(new Event("dom-ready"))
      webview.dispatchEvent(new Event("did-stop-loading"))
    })
  return webview
}
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
async function click(label: string) {
  await act(async () => button(label).click())
}

it("only enables capturing an actual loaded visible page", async () => {
  const webview = await mount(false)
  expect(button("截图").disabled).toBe(true)
  await act(async () => {
    webview.dispatchEvent(new Event("dom-ready"))
  })
  expect(button("截图").disabled).toBe(true)
  await act(async () => {
    webview.dispatchEvent(new Event("did-stop-loading"))
  })
  expect(button("截图").disabled).toBe(false)
  await act(async () => {
    webview.dispatchEvent(new Event("did-start-loading"))
    webview.dispatchEvent(new Event("did-navigate"))
    webview.dispatchEvent(new Event("dom-ready"))
  })
  expect(button("截图").disabled).toBe(true)
  await act(async () => {
    webview.dispatchEvent(new Event("did-stop-loading"))
  })
  expect(button("截图").disabled).toBe(false)
  active = false
  await act(async () => root.render(<Harness />))
  expect(button("截图").disabled).toBe(true)
})

it("keeps the internal blank page uncapturable", async () => {
  initialUrl = null
  await mount()
  expect(button("截图").disabled).toBe(true)
})

it("shows a capture and opens the same in-memory image for annotation", async () => {
  await mount()
  await click("截图")
  expect(host.querySelector<HTMLImageElement>('img[alt="页面截图"]')?.src).toBe("blob:capture-1")
  await click("查看截图并批注")
  await click("查看截图并批注")
  expect(requests).toHaveLength(2)
  expect(requests[0]).toMatchObject({ kind: "memory", mediaType: "image/png" })
  if (requests[0].kind !== "memory") throw new Error("截图应为内存图片")
  expect(Array.from(new Uint8Array(requests[0].bytes))).toEqual([1, 2, 3])
  expect(requests[1]).toBe(requests[0])
  await click("删除截图")
  expect(host.querySelector('img[alt="页面截图"]')).toBeNull()
  expect(revoked).toContain("blob:capture-1")
})

it("replaces the thumbnail with a new capture identity", async () => {
  await mount()
  await click("截图")
  await click("查看截图并批注")
  await click("截图")
  await click("查看截图并批注")
  expect(captures).toBe(2)
  expect(
    requests[0].kind === "memory" &&
      requests[1].kind === "memory" &&
      requests[0].id !== requests[1].id
  ).toBe(true)
  expect(revoked).toContain("blob:capture-1")
  expect(host.querySelector<HTMLImageElement>('img[alt="页面截图"]')?.src).toBe("blob:capture-2")
})

it("keeps a PNG download readable after the thumbnail is deleted and then releases it", async () => {
  vi.useFakeTimers()
  await mount()
  await click("截图")
  const downloads: Array<{ href: string; name: string }> = []
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    downloads.push({ href: this.href, name: this.download })
  })
  await click("保存截图")
  expect(downloads).toHaveLength(1)
  expect(downloads[0].name).toMatch(/\.png$/)
  await click("删除截图")
  expect(revoked).toContain("blob:capture-1")
  expect(revoked).not.toContain(downloads[0].href)
  expect(urls[1].type).toBe("image/png")
  expect(urls[1].size).toBe(3)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(revoked).toContain(downloads[0].href)
})

it.each(["hide", "navigate", "unmount"])("ignores a capture completed after %s", async (change) => {
  let finish!: (value: ReturnType<typeof nativeImage>) => void
  capturePage = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const webview = await mount()
  await click("截图")
  expect(button("截图").disabled).toBe(true)
  await act(async () => {
    if (change === "hide") {
      active = false
      root.render(<Harness />)
    } else if (change === "navigate") webview.dispatchEvent(new Event("did-start-loading"))
    else root.render(null)
  })
  await act(async () => finish(nativeImage()))
  expect(host.querySelector('img[alt="页面截图"]')).toBeNull()
  expect(urls).toHaveLength(0)
})

it("reports capture failures without losing the previous image", async () => {
  await mount()
  await click("截图")
  capturePage = async () => {
    throw new Error("页面截图失败")
  }
  await click("截图")
  expect(host.textContent).toContain("页面截图失败")
  expect(host.querySelector<HTMLImageElement>('img[alt="页面截图"]')?.src).toBe("blob:capture-1")
  expect(button("截图").disabled).toBe(false)
})
