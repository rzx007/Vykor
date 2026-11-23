import type { SafeImageMediaType } from "./safe-image-preview"
import type { LocalDocumentPreview } from "./document-preview"

export type WorkspaceListFilesInput =
  | { rootPath: string; sessionId?: never }
  | { sessionId: string; rootPath?: never; path?: string }

export interface WorkspaceFileEntry {
  path: string
  type: "file" | "directory"
  size?: number
}

export interface WorkspaceListFilesResult {
  rootPath?: string
  entries: WorkspaceFileEntry[]
  truncated?: boolean
}

export type WorkspaceReadFileInput = WorkspaceListFilesInput & { path: string }

export interface WorkspaceWriteFileInput {
  rootPath: string
  path: string
  originalContent: string
  content: string
}

export type WorkspaceFileScope = "project" | "extra-root" | "session"
export type WorkspaceImagePreviewError = "image_too_large" | "image_unsupported"

export interface WorkspaceReadFileResult {
  documentPreview?: LocalDocumentPreview
  path: string
  name: string
  language: string
  size: number
  binary: boolean
  content: string | null
  truncated?: boolean
  scope: WorkspaceFileScope
  relativePath: string
  rootLabel: string
  previewBytes: ArrayBuffer | null
  mediaType: SafeImageMediaType | null
  imagePreviewError: WorkspaceImagePreviewError | null
}

export interface WorkspaceRevealPathInput {
  rootPath: string
  path: string
}

export interface WorkspaceCopyPathInput {
  rootPath: string
  path: string
  absolute?: boolean
}

export type WorkspaceOpenerKind = "editor" | "folder" | "terminal"

export interface WorkspaceOpener {
  id: string
  label: string
  kind: WorkspaceOpenerKind
  iconDataUrl: string | null
}

export interface WorkspaceOpenWithInput {
  openerId: string
  path: string
  rootPath?: string
}
