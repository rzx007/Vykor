import type { ServerCapabilities } from "@vykor/client"
import { describe, expect, it } from "vitest"

import {
  disabledDesktopAttachmentSupport,
  normalizeDesktopAttachmentSupport,
  resolveDesktopAttachmentSupport,
  resolveDesktopAttachmentCompatibility,
  areDesktopAttachmentsSendable,
} from "./attachment-types"

const attachmentLimits = {
  maxFilesPerPrompt: 20,
  maxBytesPerFile: 100 * 1024 * 1024,
  maxBytesPerPrompt: 250 * 1024 * 1024,
  maxSessionReferencedBytes: 2 * 1024 * 1024 * 1024,
  resumableThresholdBytes: 25 * 1024 * 1024,
  uploadSessionTtlMs: 24 * 60 * 60 * 1_000,
  stagingTtlMs: 24 * 60 * 60 * 1_000,
}

const attachmentCapabilities: ServerCapabilities = {
  serverVersion: "0.1.0",
  protocol: { version: 2 },
  features: { attachments: 1 },
  attachments: {
    uploadModes: ["single"],
    limits: attachmentLimits,
  },
}

describe("resolveDesktopAttachmentSupport", () => {
  it("normalizes an older bootstrap without attachment capability to disabled", () => {
    expect(normalizeDesktopAttachmentSupport(undefined)).toBe(disabledDesktopAttachmentSupport)
  })

  it("enables the daemon attachment contract in development", () => {
    expect(
      resolveDesktopAttachmentSupport(attachmentCapabilities, {
        isPackaged: false,
        forceDisable: false,
      })
    ).toEqual({
      daemonSupported: true,
      interactionEnabled: true,
      uploadModes: ["single"],
      limits: attachmentLimits,
    })
  })

  it("keeps an old daemon on the text-only path", () => {
    expect(
      resolveDesktopAttachmentSupport(
        {
          serverVersion: "0.1.0",
          protocol: { version: 2 },
          features: {},
        },
        { isPackaged: false, forceDisable: false }
      )
    ).toEqual({
      daemonSupported: false,
      interactionEnabled: false,
      uploadModes: [],
      limits: null,
    })
  })

  it("enables packaged attachments by default and allows an explicit kill switch", () => {
    expect(
      resolveDesktopAttachmentSupport(attachmentCapabilities, {
        isPackaged: true,
        forceDisable: false,
      }).interactionEnabled
    ).toBe(true)

    expect(
      resolveDesktopAttachmentSupport(attachmentCapabilities, {
        isPackaged: true,
        forceDisable: true,
      }).interactionEnabled
    ).toBe(false)
  })
})

describe("desktop attachment compatibility", () => {
  it.each([
    ["notes.txt", "text/plain"],
    ["README.md", "application/octet-stream"],
    ["index.ts", "application/octet-stream"],
    ["payload.json", "application/json"],
    ["photo.png", "image/png"],
  ])("allows %s", (displayName, mediaType) => {
    expect(resolveDesktopAttachmentCompatibility({
      displayName,
      declaredMediaType: mediaType,
      mediaType,
    })).toEqual({ supported: true })
  })

  it.each([
    ["report.pdf", "application/pdf", "暂不支持 PDF 和 Office 文档"],
    ["proposal.docx", "application/zip", "暂不支持 PDF 和 Office 文档"],
    ["table.xlsx", "application/octet-stream", "暂不支持 PDF 和 Office 文档"],
    ["slides.pptx", "application/zip", "暂不支持 PDF 和 Office 文档"],
    ["source.zip", "application/zip", "暂不支持压缩包"],
    ["program.exe", "application/octet-stream", "暂不支持这种二进制文件"],
  ])("blocks %s", (displayName, mediaType, reason) => {
    expect(resolveDesktopAttachmentCompatibility({
      displayName,
      declaredMediaType: mediaType,
      mediaType,
    })).toEqual({ supported: false, reason })
  })

  it("requires every draft to be ready and supported before sending", () => {
    expect(areDesktopAttachmentsSendable([{
      draftId: "d", taskId: "t", displayName: "report.pdf",
      declaredMediaType: "application/pdf", mediaType: "application/pdf",
      sizeBytes: 4, status: "ready", bytesUploaded: 4, progress: 1, assetId: "a",
    }])).toBe(false)
  })
})
