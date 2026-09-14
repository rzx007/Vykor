import type { WorkspaceFileScope, WorkspaceReadFileResult } from "@shared/workspace-types"
import { isMarkdownPath } from "./file-icons"

const largeHtmlLineThreshold = 5_000
const documentExtensions = new Set(["doc", "docx", "pdf", "ppt", "pptx", "xls", "xlsx"])

export type FileViewerType = "code" | "document" | "image" | "markdown"

export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path)
}

export function shouldOfferHtmlBrowserOpen(path: string, content: string): boolean {
  if (!isHtmlPath(path)) return false

  let lineCount = 1
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) continue
    lineCount += 1
    if (lineCount > largeHtmlLineThreshold) return true
  }
  return false
}

export function canOpenHtmlInBrowser(scope: WorkspaceFileScope | undefined): boolean {
  return scope !== "extra-root"
}

export function fileViewerTypeForPreview(preview: WorkspaceReadFileResult): FileViewerType {
  if (preview.previewBytes !== null && preview.mediaType !== null) return "image"
  if (isMarkdownPath(preview.path)) return "markdown"

  const extension = preview.name.split(".").pop()?.toLowerCase() ?? ""
  if (preview.binary || preview.content === null || documentExtensions.has(extension)) {
    return "document"
  }

  return "code"
}
