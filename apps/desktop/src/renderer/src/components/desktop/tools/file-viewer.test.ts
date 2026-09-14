import { describe, expect, it } from "vitest"

import { mergeFileViewerTabs, type FileViewerTab } from "./file-viewer"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"

describe("mergeFileViewerTabs", () => {
  it("keeps previously opened files in the same project", () => {
    const first = fileTab("a.ts", "project-a")
    const second = fileTab("b.ts")

    expect(mergeFileViewerTabs([first], second, "project-a").map(pathOf)).toEqual(["b.ts", "a.ts"])
  })

  it("does not drop existing files when the incoming tab has no project yet", () => {
    const first = fileTab("a.ts", "project-a")
    const second = fileTab("b.ts")

    const merged = mergeFileViewerTabs([first], second, "project-a")
    expect(merged.map(pathOf)).toEqual(["b.ts", "a.ts"])
    expect(merged[0]?.projectPath).toBe("project-a")
  })

  it("replaces a file that is opened again instead of duplicating it", () => {
    const first = fileTab("a.ts", "project-a", "old")
    const updated = fileTab("a.ts", undefined, "new")

    const merged = mergeFileViewerTabs([first], updated, "project-a")
    expect(merged).toHaveLength(1)
    expect(merged[0]?.preview.content).toBe("new")
  })

  it("does not mix files from another project", () => {
    const otherProject = fileTab("other.ts", "project-b")
    const next = fileTab("a.ts")

    expect(mergeFileViewerTabs([otherProject], next, "project-a").map(pathOf)).toEqual(["a.ts"])
  })
})

function fileTab(path: string, projectPath?: string | null, content = path): FileViewerTab {
  const preview: WorkspaceReadFileResult = {
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
  return { preview, type: "code", projectPath }
}

function pathOf(tab: FileViewerTab): string {
  return tab.preview.path
}
