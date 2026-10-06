// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { WorkspaceReadFileResult } from "@shared/workspace-types"
import { FileViewer, type FileViewerTab } from "./file-viewer"
import { resetDesktopSessionStore } from "@renderer/stores/desktop-session/store-test-fixtures"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"

vi.mock("@renderer/components/appearance/appearance-provider", () => ({
  useAppearance: () => ({ resolvedTheme: "light" }),
}))

vi.mock("./virtualized-code-preview", () => ({
  VirtualizedCodePreview: () => <div data-display="code-preview" />,
}))

describe("FileViewer image rendering", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    resetDesktopSessionStore()
    useDesktopSessionStore.setState({
      activeSessionId: "file-chat",
      attachmentSupport: {
        daemonSupported: true,
        interactionEnabled: true,
        limits: null,
        uploadModes: ["single"],
      },
    })
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:file-preview"),
    })
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  it("renders a validated image instead of the code preview", async () => {
    await render(
      tab("image", {
        path: "preview.png",
        name: "preview.png",
        binary: true,
        content: null,
        previewBytes: new Uint8Array([1, 2, 3]).buffer,
        mediaType: "image/png",
      })
    )

    expect(container.querySelector('img[alt="preview.png"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="图片查看与批注"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="图片缩放"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="添加批注"]')).not.toBeNull()
    expect(container.querySelector('[data-display="code-preview"]')).toBeNull()
  })

  it("does not reload the image when unrelated file search state changes", async () => {
    const file = tab("image", {
      path: "same.png",
      name: "same.png",
      previewBytes: new Uint8Array([1]).buffer,
      mediaType: "image/png",
    })
    await render(file)
    const image = container.querySelector('img[alt="same.png"]')
    expect(image).not.toBeNull()
    await render(file, "search")
    expect(container.querySelector('img[alt="same.png"]')).toBe(image)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })

  it("releases the previous image when the file changes or its preview closes", async () => {
    await render(
      tab("image", {
        path: "one.png",
        name: "one.png",
        previewBytes: new Uint8Array([1]).buffer,
        mediaType: "image/png",
      })
    )
    const first = container.querySelector('img[alt="one.png"]')!
    await render(
      tab("image", {
        path: "two.png",
        name: "two.png",
        previewBytes: new Uint8Array([2]).buffer,
        mediaType: "image/png",
      })
    )
    expect(first.isConnected).toBe(false)
    expect(container.querySelector('img[alt="two.png"]')).not.toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    await act(async () => root.render(null))
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it("shows the shared viewer's decode error without entering the code preview", async () => {
    await render(
      tab("image", {
        path: "broken.png",
        name: "broken.png",
        previewBytes: new Uint8Array([1]).buffer,
        mediaType: "image/png",
      })
    )
    await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")))
    expect(container.textContent).toContain("无法显示这张图片")
    expect(container.querySelector('[data-display="code-preview"]')).toBeNull()
  })

  it.each([
    ["image_too_large", "图片太大，无法直接预览。"],
    ["image_unsupported", "无法安全预览这张图片。"],
  ] as const)("shows the %s document placeholder", async (imagePreviewError, message) => {
    await render(
      tab("document", {
        path: "preview.png",
        name: "preview.png",
        binary: true,
        content: null,
        imagePreviewError,
      })
    )

    expect(container.textContent).toContain(message)
  })

  async function render(fileTab: FileViewerTab, searchQuery = ""): Promise<void> {
    await act(async () => {
      // 保留真实查看器；提前等待懒加载模块，避免在 act 中等待 DOM 导致提交被挂起。
      await import("../image-viewer/image-viewer")
      root.render(
        <FileViewer
          scopeId="session:file-chat"
          tabs={[fileTab]}
          activePath={fileTab.preview.path}
          loadingPath={null}
          viewMode="source"
          searchQuery={searchQuery}
          searchMatchIndex={-1}
          searchMatches={[]}
          onOpenHtmlInBrowser={vi.fn()}
        />
      )
    })
  }
})

function tab(
  type: FileViewerTab["type"],
  overrides: Partial<WorkspaceReadFileResult>
): FileViewerTab {
  const preview: WorkspaceReadFileResult = {
    path: "file.ts",
    name: "file.ts",
    language: "typescript",
    size: 4,
    binary: false,
    content: "code",
    scope: "project",
    relativePath: "file.ts",
    rootLabel: "",
    previewBytes: null,
    mediaType: null,
    imagePreviewError: null,
    ...overrides,
  }
  return { type, preview, projectPath: "project" }
}
