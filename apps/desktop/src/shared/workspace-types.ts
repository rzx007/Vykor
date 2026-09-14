import type { SafeImageMediaType } from "./safe-image-preview"

export interface WorkspaceListFilesInput {
  rootPath: string
}

export interface WorkspaceFileEntry {
  path: string
  type: "file" | "directory"
  size?: number
}

export interface WorkspaceListFilesResult {
  rootPath: string
  entries: WorkspaceFileEntry[]
}

export interface WorkspaceReadFileInput {
  rootPath: string
  path: string
}

export type WorkspaceFileScope = "project" | "extra-root"
export type WorkspaceImagePreviewError = "image_too_large" | "image_unsupported"

export interface WorkspaceReadFileResult {
  path: string
  name: string
  language: string
  size: number
  binary: boolean
  content: string | null
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
