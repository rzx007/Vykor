// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DesktopAttachmentDraft } from "@shared/attachment-types"
import { ComposerAttachments } from "../composer-attachments"

describe("ComposerAttachments preview", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        attachments: {
          readPreview: vi.fn(async () => ({
            bytes: new Uint8Array([0xff, 0xd8, 0xff]).buffer,
            mediaType: "image/jpeg",
          })),
        },
      },
    })
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => `blob:${blob.type}:${blob.size}`),
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

  it("uses exact preview bytes and falls back to the file icon after an image decode error", async () => {
    await act(async () =>
      root.render(
        createElement(ComposerAttachments, {
          attachments: [readyImage],
          onCancel: vi.fn(),
          onRetry: vi.fn(),
          onRemove: vi.fn(),
        })
      )
    )

    const image = container.querySelector("img")
    expect(image?.getAttribute("src")).toBe("blob:image/jpeg:3")
    await act(async () => image?.dispatchEvent(new Event("error")))

    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("svg")).not.toBeNull()
  })

  it("reports a preview failure separately and retries only the preview read", async () => {
    const read = vi.mocked(window.desktop.attachments.readPreview)
    read.mockRejectedValueOnce(new Error("read failed"))
    await act(async () => root.render(createElement(ComposerAttachments, { attachments:[readyImage], onCancel:vi.fn(), onRetry:vi.fn(), onRemove:vi.fn() })))
    expect(container.textContent).toContain("预览读取失败")
    const retry=container.querySelector<HTMLButtonElement>('[aria-label="重试预览 runtime-map.jpeg"]')
    expect(retry).not.toBeNull()
    await act(async () => retry!.click())
    expect(read).toHaveBeenCalledTimes(2)
    expect(container.querySelector("img")).not.toBeNull()
  })
  it("shows a ready image as a standalone thumbnail", async () => {
    await act(async () =>
      root.render(
        createElement(ComposerAttachments, {
          attachments: [readyImage],
          onCancel: vi.fn(),
          onRetry: vi.fn(),
          onRemove: vi.fn(),
        })
      )
    )

    const imageAttachment = container.querySelector('[data-display="image-preview"]')
    expect(imageAttachment).not.toBeNull()
    expect(imageAttachment?.className).toContain("size-24")
    expect(imageAttachment?.className).toContain("border-border/50")
    expect(imageAttachment?.textContent).not.toContain(readyImage.displayName)
    expect(
      imageAttachment?.querySelector('[aria-label="移除附件 runtime-map.jpeg"]')
    ).not.toBeNull()
  })

  it("aligns image thumbnails and document cards in a mixed batch", async () => {
    await act(async () =>
      root.render(
        createElement(ComposerAttachments, {
          attachments: [readyImage, readyDocument],
          onCancel: vi.fn(),
          onRetry: vi.fn(),
          onRemove: vi.fn(),
        })
      )
    )

    const imageAttachment = container.querySelector('[data-display="image-preview"]')
    const documentAttachment = container.querySelector('[data-display="file-card"]')
    expect(imageAttachment?.className).toContain("h-20")
    expect(documentAttachment?.className).toContain("h-20")
  })
})

const readyImage: DesktopAttachmentDraft = {
  draftId: "draft-image",
  taskId: "task-image",
  displayName: "runtime-map.jpeg",
  declaredMediaType: "image/jpeg",
  sizeBytes: 648_400,
  status: "ready",
  bytesUploaded: 648_400,
  progress: 1,
  assetId: "asset-image",
  mediaType: "image/jpeg",
}

const readyDocument: DesktopAttachmentDraft = {
  draftId: "draft-document",
  taskId: "task-document",
  displayName: "release-notes.txt",
  declaredMediaType: "text/plain",
  sizeBytes: 12_000,
  status: "ready",
  bytesUploaded: 12_000,
  progress: 1,
  assetId: "asset-document",
  mediaType: "text/plain",
}
