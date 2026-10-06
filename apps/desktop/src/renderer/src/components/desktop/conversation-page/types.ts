import type { DesktopPermissionMode } from "@shared/session-types"
import type { DesktopGitDiffScope } from "@shared/git-types"

export type ConversationPaneProps = {
  panelOpen: boolean
  onTogglePanel: () => void
  onOpenFile: (path: string, line?: number) => void
  canOpenReview: boolean
  onOpenReview: (path?: string, scope?: DesktopGitDiffScope, rootPath?: string) => void
  onOpenTerminal: (terminalId: string) => void
  onOpenAgents: (taskId?: string) => void
}

export interface AddToComposerEventDetail {
  text: string
}

export type LoadStatus = "idle" | "loading" | "ready" | "error"

export type StartPicker = "project" | "runtime" | "branch"

export type PermissionModeOption = {
  value: DesktopPermissionMode
  label: string
  description: string
}
