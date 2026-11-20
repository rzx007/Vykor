import type { WorkspaceReadFileResult } from "@shared/workspace-types"
import { isMarkdownPath } from "./file-icons"

const documentExtensions = new Set(["doc", "docx", "pdf", "ppt", "pptx", "xls", "xlsx"])

export type FileViewerType = "code" | "document" | "image" | "markdown" | "local-document"

export function isWebDocumentPath(path: string): boolean {
  return /\.(?:html?|svg)$/i.test(path)
}

export function fileViewerTypeForPreview(preview: WorkspaceReadFileResult): FileViewerType {
  if (preview.documentPreview) return "local-document"
  if (preview.previewBytes !== null && preview.mediaType !== null) return "image"
  if (isMarkdownPath(preview.path)) return "markdown"
  const extension = preview.name.split(".").pop()?.toLowerCase() ?? ""
  if (preview.binary || preview.content === null || documentExtensions.has(extension)) {
    return "document"
  }

  return "code"
}
