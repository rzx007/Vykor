export type DesktopGitFileStatus =
  "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"

export type DesktopGitDiffScope = "uncommitted" | "unstaged" | "staged"

export interface DesktopGitChangesInput {
  rootPath: string
  scope?: DesktopGitDiffScope
}

export interface DesktopGitChangedFile {
  path: string
  oldPath?: string
  status: DesktopGitFileStatus
  additions: number | null
  deletions: number | null
  binary: boolean
}

export interface DesktopGitChangesResult {
  rootPath: string
  files: DesktopGitChangedFile[]
  totalAdditions: number
  totalDeletions: number
}

export interface DesktopGitFileDiffInput {
  rootPath: string
  path: string
  status?: DesktopGitFileStatus
  scope?: DesktopGitDiffScope
}

export interface DesktopGitFileDiffResult {
  path: string
  patch: string
  binary: boolean
}

export interface DesktopGitIsRepositoryInput {
  path: string
}

export interface DesktopGitIsRepositoryResult {
  isRepository: boolean
  rootPath: string | null
}
