// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { OfficeDocumentPreview } from "./office-document-preview"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"
it("keeps the document sandboxed and loads the selected page through workspace read", async () => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const preview = {
    path: "slides.pptx",
    name: "slides.pptx",
    officePreview: { html: "<p>first</p>", format: "pptx", page: 1, pageCount: 2, sha256: "hash" },
  } as WorkspaceReadFileResult
  const readFile = vi.fn(async () => ({
    ...preview,
    officePreview: { ...preview.officePreview!, html: "<p>second</p>", page: 2 },
  }))
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { workspace: { readFile } },
  })
  try {
    await act(async () =>
      root.render(<OfficeDocumentPreview preview={preview} rootPath="C:/work" />)
    )
    const frame = container.querySelector("iframe")!
    expect(frame.getAttribute("sandbox")).toBe("")
    expect(frame.getAttribute("srcdoc")).toContain("script-src 'none'")
    await act(async () => {
      ;(container.querySelector('[aria-label="下一页"]') as HTMLButtonElement).click()
    })
    expect(frame.getAttribute("srcdoc")).toContain("second")
    expect(readFile).toHaveBeenCalledWith({
      rootPath: "C:/work",
      path: "slides.pptx",
      officePage: 2,
    })
    expect((container.querySelector('[aria-label="下一页"]') as HTMLButtonElement).disabled).toBe(
      true
    )
  } finally {
    act(() => root.unmount())
    container.remove()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  }
})

it("adapts to panel width, keeps manual zoom and restores fitting for a new file", async () => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  let resize: ResizeObserverCallback
  const disconnect = vi.fn()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback
      }
      observe() {}
      disconnect = disconnect
    }
  )
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const preview = {
    path: "slides.pptx",
    name: "slides.pptx",
    officePreview: {
      html: '<style>:root{--slide-design-w:750pt}</style><div class="slide"></div>',
      format: "pptx",
      page: 1,
      pageCount: 1,
      sha256: "hash",
    },
  } as WorkspaceReadFileResult
  const measure = (width: number) =>
    act(() => resize([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver))
  const click = (label: string) =>
    act(() => (container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click())
  const percentage = () => container.querySelector('[aria-label="缩放比例"]')?.textContent
  try {
    await act(async () =>
      root.render(<OfficeDocumentPreview preview={preview} rootPath="C:/work" />)
    )
    measure(1040)
    expect(percentage()).toBe("100%")
    measure(528)
    expect(percentage()).toBe("50%")
    click("放大预览")
    expect(percentage()).toBe("60%")
    measure(1040)
    expect(percentage()).toBe("60%")
    click("适应宽度")
    expect(percentage()).toBe("100%")
    click("缩小预览")
    await act(async () =>
      root.render(
        <OfficeDocumentPreview
          preview={{ ...preview, path: "other.pptx", name: "真实文件名.pptx" }}
          rootPath="C:/work"
        />
      )
    )
    expect(percentage()).toBe("100%")
    expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("真实文件名.pptx")
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("")
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  }
  expect(disconnect).toHaveBeenCalledOnce()
})
