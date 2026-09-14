import { describe, expect, it } from "vitest"

import type { WorkspaceReadFileResult } from "@shared/workspace-types"
import {
  canOpenHtmlInBrowser,
  fileViewerTypeForPreview,
  isHtmlPath,
  shouldOfferHtmlBrowserOpen,
} from "./file-viewer-model"

describe("isHtmlPath", () => {
  it("recognizes HTML and HTM extensions without case sensitivity", () => {
    expect(isHtmlPath("site/index.html")).toBe(true)
    expect(isHtmlPath("site/legacy.HTM")).toBe(true)
  })

  it("rejects non-HTML files", () => {
    expect(isHtmlPath("site/index.ts")).toBe(false)
  })
})

describe("shouldOfferHtmlBrowserOpen", () => {
  it("offers browser rendering only when HTML exceeds 5000 lines", () => {
    expect(shouldOfferHtmlBrowserOpen("report.html", lines(5_000))).toBe(false)
    expect(shouldOfferHtmlBrowserOpen("report.HTML", lines(5_001))).toBe(true)
  })

  it("does not offer browser rendering for a non-HTML file", () => {
    expect(shouldOfferHtmlBrowserOpen("report.ts", lines(5_001))).toBe(false)
  })
})

describe("canOpenHtmlInBrowser", () => {
  it("hides the browser action for extra-root previews", () => {
    expect(canOpenHtmlInBrowser("extra-root")).toBe(false)
    expect(canOpenHtmlInBrowser("project")).toBe(true)
    expect(canOpenHtmlInBrowser(undefined)).toBe(true)
  })
})

describe("fileViewerTypeForPreview", () => {
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

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
}

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
