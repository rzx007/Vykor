// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { WorkspaceReadFileResult } from "@shared/workspace-types"
import { FileViewer, type FileViewerTab } from "./file-viewer"

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

  async function render(fileTab: FileViewerTab): Promise<void> {
    await act(async () => {
      root.render(
        <FileViewer
          tabs={[fileTab]}
          activePath={fileTab.preview.path}
          loadingPath={null}
          viewMode="source"
          searchQuery=""
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
