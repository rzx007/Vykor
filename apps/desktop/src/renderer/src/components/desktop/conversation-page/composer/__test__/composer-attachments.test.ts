import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { DesktopAttachmentDraft } from "@shared/attachment-types"
import { ComposerAttachments } from "../composer-attachments"
import { readComposerClipboard, readComposerDrop } from "../composer-file-input"

const uploading: DesktopAttachmentDraft = {
  draftId: "draft-uploading",
  taskId: "task-uploading",
  displayName: "产品发布中心.pdf",
  declaredMediaType: "application/pdf",
  sizeBytes: 1_000,
  status: "uploading",
  bytesUploaded: 420,
  progress: 0.42,
}

const ready: DesktopAttachmentDraft = {
  ...uploading,
  draftId: "draft-ready",
  displayName: "投标文件.docx",
  declaredMediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  status: "ready",
  bytesUploaded: 1_000,
  progress: 1,
  assetId: "asset-ready",
  mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}

const failed: DesktopAttachmentDraft = {
  ...uploading,
  draftId: "draft-failed",
  displayName: "凡人修仙传.txt",
  declaredMediaType: "text/plain",
  status: "failed",
  error: {
    code: "network_error",
    message: "上传中断，请重试",
    retryable: true,
  },
}

describe("ComposerAttachments", () => {
  it("renders uploading, ready, and failed cards with accessible actions", () => {
    const html = renderToStaticMarkup(
      createElement(ComposerAttachments, {
        attachments: [uploading, ready, failed],
        onCancel: vi.fn(),
        onRetry: vi.fn(),
        onRemove: vi.fn(),
      })
    )

    expect(html).toContain("产品发布中心.pdf")
    expect(html).toContain("投标文件.docx")
    expect(html).toContain("凡人修仙传.txt")
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="42"')
    expect(html).toContain('aria-label="取消上传 产品发布中心.pdf"')
    expect(html).toContain('aria-label="移除附件 投标文件.docx"')
    expect(html).toContain('aria-label="重试上传 凡人修仙传.txt"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain("上传中断，请重试")
    expect(html).toContain('aria-label="产品发布中心.pdf：正在上传"')
    expect(html).toContain('aria-label="投标文件.docx：已就绪"')
    expect(html).toContain('aria-label="凡人修仙传.txt：上传中断，请重试"')
    expect(html).not.toContain("个附件正在准备")
    expect(html).not.toContain("个附件需要处理")
  })

  it("keeps accompanying text when pasted files are present", () => {
    const image = new File(["image"], "clipboard.png", { type: "image/png" })

    expect(
      readComposerClipboard({
        files: { 0: image, length: 1 },
        getData: (type) => (type === "text/plain" ? "看一下这张图" : ""),
      })
    ).toEqual({ files: [image], text: "看一下这张图" })
  })

  it("returns dropped files without treating accompanying text as a second attachment", () => {
    const document = new File(["document"], "notes.txt", { type: "text/plain" })

    expect(readComposerDrop({ 0: document, length: 1 })).toEqual([document])
  })
})
