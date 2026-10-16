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
