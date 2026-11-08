import { describe, expect, it } from "vitest"

import type { WorkspaceReadFileResult } from "@shared/workspace-types"
import { fileViewerTypeForPreview, isWebDocumentPath } from "../file-viewer-model"

describe("isWebDocumentPath", () => {
  it.each(["site/index.html", "site/legacy.HTM", "images/diagram.SVG"])("recognizes %s", (path) => {
    expect(isWebDocumentPath(path)).toBe(true)
  })
  it("rejects other files", () => {
    expect(isWebDocumentPath("site/index.ts")).toBe(false)
  })
})

describe("fileViewerTypeForPreview", () => {
  it.each(["pdf", "epub", "docx", "xlsx", "pptx"] as const)(
    "routes %s bytes into the local viewer",
    (format) => {
      expect(
        fileViewerTypeForPreview(
          preview({
            name: `report.${format}`,
            binary: true,
            content: null,
            documentPreview: { format, bytes: new ArrayBuffer(1) },
          })
        )
      ).toBe("local-document")
    }
  )
  it("classifies a complete validated image result as an image", () => {
    expect(
      fileViewerTypeForPreview(
        preview({
          path: "a.png",
          name: "a.png",
          binary: true,
          content: null,
          previewBytes: new Uint8Array([1]).buffer,
          mediaType: "image/png",
        })
      )
    ).toBe("image")
  })

  it("does not classify incomplete image data as an image", () => {
    expect(
      fileViewerTypeForPreview(
        preview({
          path: "a.png",
          name: "a.png",
          binary: true,
          content: null,
          previewBytes: new Uint8Array([1]).buffer,
        })
      )
    ).toBe("document")
    expect(
      fileViewerTypeForPreview(
        preview({
          path: "a.png",
          name: "a.png",
          binary: true,
          content: null,
          mediaType: "image/png",
        })
      )
    ).toBe("document")
  })

  it("keeps image failures as document placeholders", () => {
    expect(
      fileViewerTypeForPreview(
        preview({
          path: "huge.png",
          name: "huge.png",
          binary: true,
          content: null,
          mediaType: "image/png",
          imagePreviewError: "image_too_large",
        })
      )
    ).toBe("document")
  })

  it.each([
    ["README.md", "markdown"],
    ["report.pdf", "document"],
    ["archive.bin", "document"],
    ["source.ts", "code"],
  ] as const)("classifies %s as %s", (path, type) => {
    const document = path.endsWith(".pdf") || path.endsWith(".bin")
    expect(
      fileViewerTypeForPreview(
        preview({
          path,
          name: path,
          binary: document,
          content: document ? null : "content",
        })
      )
    ).toBe(type)
  })
})

function preview(overrides: Partial<WorkspaceReadFileResult> = {}): WorkspaceReadFileResult {
  return {
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
}
