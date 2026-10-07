import type { DesktopGitDiffScope } from "./git-types"

export const GitSettingsChannels = {
  snapshot: "git-settings:snapshot",
  preferences: "git-settings:preferences",
  identity: "git-settings:identity",
  cleanup: "git-settings:cleanup",
  markDisposable: "git-settings:mark-disposable",
  chooseDirectory: "git-settings:choose-directory",
  readPreferences: "git-settings:read-preferences",
} as const
export interface GitPreferences {
  defaultScope: DesktopGitDiffScope
  viewMode: "unified" | "split"
  ignoreWhitespace: boolean
  branchPrefix: string
  defaultTaskLocation: "current" | "worktree"
  worktreeRoot: string | null
  autoCleanup: boolean
}
export const defaultGitPreferences: GitPreferences = {
  defaultScope: "uncommitted",
  viewMode: "unified",
  ignoreWhitespace: false,
  branchPrefix: "vykor/",
  defaultTaskLocation: "current",
  worktreeRoot: null,
  autoCleanup: false,
}
export interface GitDetection {
  environment: "native" | "wsl"
  distribution?: string
  available: boolean
  version?: string
  executable?: string
  error?: string
}
export interface GitIdentityValue {
  value: string
  source: string
}
export interface GitIdentity {
  name: GitIdentityValue
  email: GitIdentityValue
  configuredName: string
  configuredEmail: string
}
export interface ManagedGitWorktree {
  id: string
  projectId: string
  projectPath: string
  path: string
  branch: string
  sessionId?: string
  task?: string
  bytes: number | null
  dirty: boolean | null
  active: boolean
  preserved: boolean
  disposable: boolean
  cleanupAllowed: boolean
  directoryRemoved?: boolean
  reason?: string
}
export interface GitSettingsSnapshot {
  preferences: GitPreferences
  desktopGit: GitDetection
  agentGit: GitDetection
  agentEnvironmentSource: string
  projectPath?: string
  repository: boolean
  identityEnvironment: "native" | "wsl"
  globalIdentity: GitIdentity | null
  projectIdentity: GitIdentity | null
  worktrees: ManagedGitWorktree[]
  errors: string[]
}
export interface GitSettingsScope {
  projectId?: string
  environment?: "native" | "wsl"
}
export interface UpdateGitPreferencesInput {
  preferences: GitPreferences
  expected: GitPreferences
}
export interface UpdateGitIdentityInput extends GitSettingsScope {
  scope: "global" | "project"
  name: string
  email: string
  expectedName: string
  expectedEmail: string
}
export interface GitSettingsAPI {
  readPreferences(): Promise<GitPreferences>
  snapshot(input?: GitSettingsScope): Promise<GitSettingsSnapshot>
  updatePreferences(input: UpdateGitPreferencesInput): Promise<GitPreferences>
  updateIdentity(input: UpdateGitIdentityInput): Promise<GitSettingsSnapshot>
  cleanup(input: { id: string }): Promise<void>
  markDisposable(input: { id: string; disposable: boolean }): Promise<void>
  chooseDirectory(): Promise<string | null>
}
export interface GitSettingsIpcMap {
  [GitSettingsChannels.readPreferences]: { args: []; result: GitPreferences }
  [GitSettingsChannels.snapshot]: { args: [input?: GitSettingsScope]; result: GitSettingsSnapshot }
  [GitSettingsChannels.preferences]: {
    args: [input: UpdateGitPreferencesInput]
    result: GitPreferences
  }
  [GitSettingsChannels.identity]: {
    args: [input: UpdateGitIdentityInput]
    result: GitSettingsSnapshot
  }
  [GitSettingsChannels.cleanup]: { args: [input: { id: string }]; result: void }
  [GitSettingsChannels.markDisposable]: {
    args: [input: { id: string; disposable: boolean }]
    result: void
  }
  [GitSettingsChannels.chooseDirectory]: { args: []; result: string | null }
}
