import { describe, expect, it } from "vitest"

import { createPreviewFile, resolvePreviewScrollTop } from "./virtualized-code-preview-model"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"

describe("createPreviewFile", () => {
  it("preserves syntax highlighting metadata for a large source file", () => {
    expect(createPreviewFile(preview("large.ts"))).toMatchObject({
      name: "large.ts",
      contents: "const answer = 42\n",
      lang: "typescript",
      cacheKey: "large.ts:18",
    })
  })

  it("detects the language from the filename", () => {
    expect(createPreviewFile(preview("component.tsx"))).toMatchObject({
      name: "component.tsx",
      lang: "tsx",
      cacheKey: "component.tsx:18",
    })
  })
})

describe("resolvePreviewScrollTop", () => {
  it("converts a zero-based search line into the virtualizer offset", () => {
    expect(resolvePreviewScrollTop({ searchLine: 100 })).toBe(1_928)
  })

  it("converts a one-based target line without producing a negative offset", () => {
    expect(resolvePreviewScrollTop({ targetLine: 1 })).toBe(0)
  })

  it("prefers the active search match over a target line", () => {
    expect(resolvePreviewScrollTop({ searchLine: 3, targetLine: 200 })).toBe(0)
  })

  it("returns null when there is no active line", () => {
    expect(resolvePreviewScrollTop({})).toBeNull()
  })
})

function preview(path: string): WorkspaceReadFileResult {
  const content = "const answer = 42\n"
  return {
    path,
    name: path,
    language: "typescript",
    size: content.length,
    binary: false,
    content,
    scope: "project",
    relativePath: path,
    rootLabel: "",
    previewBytes: null,
    mediaType: null,
    imagePreviewError: null,
  }
}
