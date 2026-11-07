import { describe, expect, it } from "vitest"

import type { WorkspaceReadFileResult } from "@shared/workspace-types"
import {
  fileViewerTypeForPreview,
  isHtmlPath,
} from "../file-viewer-model"

describe("isHtmlPath", () => {
  it("recognizes HTML and HTM extensions without case sensitivity", () => {
    expect(isHtmlPath("site/index.html")).toBe(true)
    expect(isHtmlPath("site/legacy.HTM")).toBe(true)
  })

  it("rejects non-HTML files", () => {
    expect(isHtmlPath("site/index.ts")).toBe(false)
  })
})

describe("fileViewerTypeForPreview", () => {
  it.each(["project", "extra-root"] as const)("renders %s SVG using an isolated browser rather than inline markup", scope => {
    expect(fileViewerTypeForPreview(preview({
      path: "artwork/diagram.SVG", name: "diagram.SVG", scope,
      content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="20" /></svg>',
    }))).toBe("svg")
  })
  it.each(["project", "extra-root"] as const)("renders HTML of every size in the browser for %s files", scope => {
    for (const content of ["<p>small</p>", "<p>line</p>\n".repeat(5_001), null]) {
      expect(fileViewerTypeForPreview(preview({
        path: "reports/report.HTML", name: "report.HTML", scope,
        content, binary: content === null,
      }))).toBe("html")
    }
  })
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
