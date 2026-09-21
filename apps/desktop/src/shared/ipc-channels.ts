import type {
  CreateDesktopSessionInput,
  CheckoutDesktopProjectBranchInput,
  CreateDesktopProjectBranchInput,
  DesktopBootstrapData,
  DesktopDaemonStatus,
  DesktopProjectDetails,
  DesktopCommandCatalogEntry,
  DesktopPluginCatalogEntry,
  CompactDesktopSessionInput,
  DesktopCompactSessionResult,
  DesktopSessionRecord,
  DesktopSessionLists,
  DesktopSessionView,
  CloseDesktopAuxSessionInput,
  EditLatestDesktopPromptInput,
  ForkDesktopSessionInput,
  InterruptDesktopSessionInput,
  PromoteDesktopQueuedPromptInput,
  CancelDesktopQueuedPromptInput,
  PinDesktopSessionInput,
  PinDesktopProjectInput,
  OpenDesktopAuxSessionInput,
  GetDesktopContextUsageInput,
  RenameDesktopProjectInput,
  RenameDesktopSessionInput,
  ReplyDesktopPermissionInput,
  SetDefaultDesktopProjectShellInput,
  SendDesktopPromptInput,
  SetDefaultDesktopModelInput,
  SetDefaultDesktopPermissionModeInput,
  UpdateDesktopSessionModelInput,
  UpdateDesktopSessionPermissionModeInput,
  UpdateDesktopSessionEffortInput,
  GetDesktopSessionGoalInput,
  CreateDesktopSessionGoalInput,
  UpdateDesktopSessionGoalInput,
  DesktopSessionGoalActionInput,
  SessionGoal,
} from "./session-types"
import type { DesktopContextUsageSnapshot } from "./context-usage-types"
import type { DesktopActivityUpdate } from "./activity-types"
import type {
  WorkspaceListFilesInput,
  WorkspaceListFilesResult,
  WorkspaceCopyPathInput,
  WorkspaceReadFileInput,
  WorkspaceReadFileResult,
  WorkspaceRevealPathInput,
  WorkspaceOpenWithInput,
  WorkspaceOpener,
} from "./workspace-types"
import type {
  DesktopDetectedTerminalShell,
  DesktopTerminalCreateInput,
  DesktopTerminalReadInput,
  DesktopTerminalReadResult,
  DesktopTerminalRecord,
  DesktopTerminalResizeInput,
  DesktopTerminalWriteInput,
} from "./terminal-types"
import type {
  CreateDesktopScheduledTaskInput,
  DesktopScheduledRun,
  DesktopScheduledStatus,
  DesktopScheduledTask,
  ListDesktopScheduledRunsInput,
  UpdateDesktopScheduledTaskInput,
} from "./schedule-types"
import type {
  ActivateDesktopProviderInput,
  ConnectDesktopProviderInput,
  DesktopProviderSnapshot,
  DisconnectDesktopProviderInput,
  CreateDesktopCustomProviderInput,
  UpdateDesktopCatalogProviderHeadersInput,
  UpdateDesktopCustomProviderInput,
  RemoveDesktopCustomProviderInput,
} from "./provider-types"
import type {
  DesktopGitChangesInput,
  DesktopGitChangesResult,
  DesktopGitFileDiffInput,
  DesktopGitFileDiffResult,
  DesktopGitIsRepositoryInput,
  DesktopGitIsRepositoryResult,
} from "./git-types"
import type {
  DesktopPluginActionInput,
  DesktopPluginArchiveCancelInput,
  DesktopPluginArchiveConfirmResult,
  DesktopPluginArchiveConfirmInput,
  DesktopPluginGitConfirmResult,
  DesktopPluginGitImportInput,
  DesktopPluginGitImportResult,
  DesktopPluginArchiveImportInput,
  DesktopPluginArchiveImportResult,
  DesktopPluginContextInput,
  DesktopPluginSnapshot,
} from "./plugin-types"
import type {
  DesktopSkillRemoveInput,
  DesktopSkillSnapshot,
  DesktopSkillSnapshotInput,
} from "./skill-types"
import type {
  DesktopSettingsSnapshot,
  DesktopDaemonAutoStartSnapshot,
  UpdateDesktopAgentEnvironmentInput,
  UpdateDesktopDefaultOpenerInput,
  UpdateDesktopDefaultTerminalShellInput,
  UpdateDesktopNotificationModeInput,
  UpdateDesktopWorkStyleInput,
} from "./settings-types"
import type {
  CancelDesktopAttachmentUploadInput,
  DesktopAttachmentAssetInput,
  DesktopAttachmentCandidate,
  DesktopAttachmentPreview,
  DiscardDesktopAttachmentDraftInput,
  RetryDesktopAttachmentUploadInput,
  StartDesktopAttachmentUploadInput,
  UploadDesktopAttachmentMemoryInput,
} from "./attachment-types"
import type {
  AttachmentStorageGcResult,
  AttachmentStorageRepairResult,
  AttachmentStorageReport,
} from "@openharness/client"
import type { DesktopUpdateState } from "./update-types"
import type { DesktopMcpLoginInput, DesktopMcpLogoutInput, DesktopMcpSnapshot } from "./mcp-types"
import type { ChannelRuntimeStatus, FeishuChannelSnapshot } from "@openharness/client"
import type {
  DesktopConnectionsSnapshot,
  DesktopFeishuAllowInput,
  DesktopFeishuConnectInput,
  DesktopFeishuPatchInput,
  DesktopFeishuRegistrationSnapshot,
  DesktopFeishuRegistrationStartInput,
  DesktopRuntimeDelta,
} from "./channel-types"

export const IpcChannels = {
  appGetInfo: "app:get-info",
  appGetPlatform: "app:get-platform",
  appQuit: "app:quit",

  updateGetState: "update:get-state",
  updateDownload: "update:download",
  updateInstall: "update:install",

  windowShowMain: "window:show-main",
  windowMinimize: "window:minimize",
  windowClose: "window:close",
  windowToggleMaximize: "window:toggle-maximize",
  windowIsMaximized: "window:is-maximized",
  windowGetZoomLevel: "window:get-zoom-level",
  windowSetZoomLevel: "window:set-zoom-level",
  windowOpenExternal: "window:open-external",

  trayFlash: "tray:flash",
  trayStopFlash: "tray:stop-flash",
  trayNotify: "tray:notify",

  petShow: "pet:show",
  petHide: "pet:hide",
  petToggle: "pet:toggle",
  petGetState: "pet:get-state",
  petSetAlwaysOnTop: "pet:set-always-on-top",
  petSetIgnoreMouseEvents: "pet:set-ignore-mouse-events",

  sessionBootstrap: "session:bootstrap",
  activityOpen: "activity:open",
  sessionList: "session:list",
  sessionDaemonStatus: "session:daemon-status",
  sessionChooseProject: "session:choose-project",
  sessionInspectProject: "session:inspect-project",
  sessionListCommands: "session:list-commands",
  sessionListContextPlugins: "session:list-context-plugins",
  sessionCompact: "session:compact",
  sessionGoalGet: "session:goal:get",
  sessionGoalCreate: "session:goal:create",
  sessionGoalUpdate: "session:goal:update",
  sessionGoalAction: "session:goal:action",
  projectRename: "project:rename",
  projectSetPinned: "project:set-pinned",
  projectSetDefaultShell: "project:set-default-shell",
  projectRemove: "project:remove",
  projectRebind: "project:rebind",
  projectCheckoutBranch: "project:checkout-branch",
  projectCreateBranch: "project:create-branch",
  sessionCreate: "session:create",
  sessionOpen: "session:open",
  sessionAuxOpen: "session:aux-open",
  sessionAuxClose: "session:aux-close",
  sessionFork: "session:fork",
  sessionClose: "session:close",
  sessionSendPrompt: "session:send-prompt",
  sessionEditLatestPrompt: "session:edit-latest-prompt",
  sessionPromoteQueuedPrompt: "session:promote-queued-prompt",
  sessionCancelQueuedPrompt: "session:cancel-queued-prompt",
  sessionInterrupt: "session:interrupt",
  sessionReplyPermission: "session:reply-permission",
  sessionSetDefaultModel: "session:set-default-model",
  sessionSetDefaultPermissionMode: "session:set-default-permission-mode",
  sessionUpdateModel: "session:update-model",
  sessionUpdatePermissionMode: "session:update-permission-mode",
  sessionUpdateEffort: "session:update-effort",
  sessionGetContextUsage: "session:get-context-usage",
  sessionRename: "session:rename",
  sessionSetPinned: "session:set-pinned",
  sessionArchive: "session:archive",
  sessionDelete: "session:delete",

  attachmentPickFiles: "attachment:pick-files",
  attachmentPickImages: "attachment:pick-images",
  attachmentStageDropped: "attachment:stage-dropped",
  attachmentUploadMemory: "attachment:upload-memory",
  attachmentStartUpload: "attachment:start-upload",
  attachmentCancelUpload: "attachment:cancel-upload",
  attachmentRetryUpload: "attachment:retry-upload",
  attachmentDiscardDraft: "attachment:discard-draft",
  attachmentDeleteUnreferenced: "attachment:delete-unreferenced",
  attachmentReadPreview: "attachment:read-preview",
  attachmentOpen: "attachment:open",
  attachmentSaveAs: "attachment:save-as",
  attachmentStorageScan: "attachment:storage-scan",
  attachmentStorageRepair: "attachment:storage-repair",
  attachmentStorageGc: "attachment:storage-gc",

  workspaceListFiles: "workspace:list-files",
  workspaceReadFile: "workspace:read-file",
  workspaceRevealPath: "workspace:reveal-path",
  workspaceCopyPath: "workspace:copy-path",
  workspaceListOpeners: "workspace:list-openers",
  workspaceOpenWith: "workspace:open-with",

  gitChanges: "git:changes",
  gitFileDiff: "git:file-diff",
  gitIsRepository: "git:is-repository",

  clipboardReadText: "clipboard:read-text",
  clipboardWriteText: "clipboard:write-text",

  terminalCreate: "terminal:create",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalRead: "terminal:read",
  terminalKill: "terminal:kill",
  terminalList: "terminal:list",
  terminalListShells: "terminal:list-shells",

  scheduleStatus: "schedule:status",
  scheduleList: "schedule:list",
  scheduleCreate: "schedule:create",
  scheduleUpdate: "schedule:update",
  scheduleRemove: "schedule:remove",
  scheduleRunNow: "schedule:run-now",
  scheduleListRuns: "schedule:list-runs",
  scheduleSetRunUnread: "schedule:set-run-unread",

  providerSnapshot: "provider:snapshot",
  providerConnect: "provider:connect",
  providerActivate: "provider:activate",
  providerDisconnect: "provider:disconnect",
  providerCatalogHeadersUpdate: "provider:catalog-headers-update",
  providerCustomCreate: "provider:custom-create",
  providerCustomUpdate: "provider:custom-update",
  providerCustomRemove: "provider:custom-remove",

  mcpSnapshot: "mcp:snapshot",
  mcpLogin: "mcp:login",
  mcpLogout: "mcp:logout",

  connectionsSnapshot: "connections:snapshot",
  connectionsRuntimeStatus: "connections:runtime-status",
  connectionsFeishuConnect: "connections:feishu-connect",
  connectionsFeishuPatch: "connections:feishu-patch",
  connectionsFeishuRemove: "connections:feishu-remove",
  connectionsFeishuAllowAdd: "connections:feishu-allow-add",
  connectionsFeishuAllowRemove: "connections:feishu-allow-remove",
  connectionsFeishuRegistrationStart: "connections:feishu-registration-start",
  connectionsFeishuRegistrationStatus: "connections:feishu-registration-status",
  connectionsFeishuRegistrationCancel: "connections:feishu-registration-cancel",
  connectionsRuntimeStart: "connections:runtime-start",
  connectionsRuntimeStop: "connections:runtime-stop",

  pluginSnapshot: "plugin:snapshot",
  pluginEnable: "plugin:enable",
  pluginDisable: "plugin:disable",
  pluginUninstall: "plugin:uninstall",
  pluginReload: "plugin:reload",
  pluginImportArchive: "plugin:import-archive",
  pluginConfirmArchive: "plugin:confirm-archive",
  pluginCancelArchive: "plugin:cancel-archive",
  pluginImportGit: "plugin:import-git",
  pluginConfirmGit: "plugin:confirm-git",
  pluginCancelGit: "plugin:cancel-git",

  skillSnapshot: "skill:snapshot",
  skillRemove: "skill:remove",

  settingsSnapshot: "settings:snapshot",
  settingsUpdateWorkStyle: "settings:update-work-style",
  settingsUpdateNotificationMode: "settings:update-notification-mode",
  settingsUpdateAgentEnvironment: "settings:update-agent-environment",
  settingsUpdateDefaultOpener: "settings:update-default-opener",
  settingsUpdateDefaultTerminalShell: "settings:update-default-terminal-shell",
  daemonAutoStartSnapshot: "daemon-autostart:snapshot",
  daemonAutoStartEnable: "daemon-autostart:enable",
  daemonAutoStartDisable: "daemon-autostart:disable",
  daemonAutoStartDismissOnboarding: "daemon-autostart:dismiss-onboarding",
} as const

export const IpcEvents = {
  updateStateChanged: "update:state-changed",
  windowMaximizedChanged: "window:maximized-changed",
  petClicked: "pet:clicked",
  sessionUpdated: "session:updated",
  activityUpdated: "activity:updated",
  sessionAuxUpdated: "session:aux-updated",
  sessionDaemonStatusChanged: "session:daemon-status-changed",
  attachmentUploadEvent: "attachment:upload-event",
  terminalData: "terminal:data",
  terminalStatus: "terminal:status",
  terminalExit: "terminal:exit",
  terminalError: "terminal:error",
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

export interface DesktopAppInfo {
  name: string
  version: string
  isPackaged: boolean
}

export interface PlatformInfo {
  platform: string
  isMac: boolean
  isWindows: boolean
  isLinux: boolean
}

export interface TrayNotificationOptions {
  title: string
  body: string
  silent?: boolean
  showWhenFocused?: boolean
}

export interface PetPosition {
  x: number
  y: number
}

export interface PetState {
  visible: boolean
  alwaysOnTop: boolean
  ignoreMouseEvents: boolean
  position: PetPosition | null
}

export interface IpcInvokeMap {
  [IpcChannels.appGetInfo]: { args: []; result: DesktopAppInfo }
  [IpcChannels.appGetPlatform]: { args: []; result: PlatformInfo }
  [IpcChannels.appQuit]: { args: []; result: void }

  [IpcChannels.updateGetState]: { args: []; result: DesktopUpdateState }
  [IpcChannels.updateDownload]: { args: []; result: void }
  [IpcChannels.updateInstall]: { args: []; result: void }

  [IpcChannels.windowShowMain]: { args: []; result: void }
  [IpcChannels.windowMinimize]: { args: []; result: void }
  [IpcChannels.windowClose]: { args: []; result: void }
  [IpcChannels.windowToggleMaximize]: { args: []; result: void }
  [IpcChannels.windowIsMaximized]: { args: []; result: boolean }
  [IpcChannels.windowGetZoomLevel]: { args: []; result: number }
  [IpcChannels.windowSetZoomLevel]: { args: [level: number]; result: number }
  [IpcChannels.windowOpenExternal]: { args: [url: string]; result: void }

  [IpcChannels.trayFlash]: { args: []; result: void }
  [IpcChannels.trayStopFlash]: { args: []; result: void }
  [IpcChannels.trayNotify]: { args: [options: TrayNotificationOptions]; result: void }

  [IpcChannels.petShow]: { args: []; result: void }
  [IpcChannels.petHide]: { args: []; result: void }
  [IpcChannels.petToggle]: { args: []; result: PetState }
  [IpcChannels.petGetState]: { args: []; result: PetState }
  [IpcChannels.petSetAlwaysOnTop]: { args: [value: boolean]; result: PetState }
  [IpcChannels.petSetIgnoreMouseEvents]: { args: [value: boolean]; result: PetState }

  [IpcChannels.settingsSnapshot]: { args: []; result: DesktopSettingsSnapshot }
  [IpcChannels.settingsUpdateWorkStyle]: {
    args: [input: UpdateDesktopWorkStyleInput]
    result: DesktopSettingsSnapshot
  }
  [IpcChannels.settingsUpdateNotificationMode]: {
    args: [input: UpdateDesktopNotificationModeInput]
    result: DesktopSettingsSnapshot
  }
  [IpcChannels.settingsUpdateAgentEnvironment]: {
    args: [input: UpdateDesktopAgentEnvironmentInput]
    result: DesktopSettingsSnapshot
  }
  [IpcChannels.settingsUpdateDefaultOpener]: {
    args: [input: UpdateDesktopDefaultOpenerInput]
    result: DesktopSettingsSnapshot
  }
  [IpcChannels.settingsUpdateDefaultTerminalShell]: {
    args: [input: UpdateDesktopDefaultTerminalShellInput]
    result: DesktopSettingsSnapshot
  }
  [IpcChannels.daemonAutoStartSnapshot]: { args: []; result: DesktopDaemonAutoStartSnapshot }
  [IpcChannels.daemonAutoStartEnable]: { args: []; result: DesktopDaemonAutoStartSnapshot }
  [IpcChannels.daemonAutoStartDisable]: { args: []; result: DesktopDaemonAutoStartSnapshot }
  [IpcChannels.daemonAutoStartDismissOnboarding]: {
    args: []
    result: DesktopDaemonAutoStartSnapshot
  }

  [IpcChannels.mcpSnapshot]: { args: []; result: DesktopMcpSnapshot }
  [IpcChannels.mcpLogin]: { args: [input: DesktopMcpLoginInput]; result: DesktopMcpSnapshot }
  [IpcChannels.mcpLogout]: { args: [input: DesktopMcpLogoutInput]; result: DesktopMcpSnapshot }

  [IpcChannels.connectionsSnapshot]: { args: []; result: DesktopConnectionsSnapshot }
  [IpcChannels.connectionsRuntimeStatus]: { args: []; result: DesktopRuntimeDelta }
  [IpcChannels.connectionsFeishuConnect]: {
    args: [input: DesktopFeishuConnectInput]
    result: { feishu: FeishuChannelSnapshot; runtime: ChannelRuntimeStatus }
  }
  [IpcChannels.connectionsFeishuPatch]: {
    args: [input: DesktopFeishuPatchInput]
    result: { feishu: FeishuChannelSnapshot; runtime: ChannelRuntimeStatus }
  }
  [IpcChannels.connectionsFeishuRemove]: {
    args: []
    result: { feishu: FeishuChannelSnapshot; runtime: ChannelRuntimeStatus }
  }
  [IpcChannels.connectionsFeishuAllowAdd]: {
    args: [input: DesktopFeishuAllowInput]
    result: FeishuChannelSnapshot
  }
  [IpcChannels.connectionsFeishuAllowRemove]: {
    args: [key: string]
    result: FeishuChannelSnapshot
  }
  [IpcChannels.connectionsFeishuRegistrationStart]: {
    args: [input: DesktopFeishuRegistrationStartInput]
    result: DesktopFeishuRegistrationSnapshot
  }
  [IpcChannels.connectionsFeishuRegistrationStatus]: {
    args: []
    result: DesktopFeishuRegistrationSnapshot
  }
  [IpcChannels.connectionsFeishuRegistrationCancel]: {
    args: []
    result: DesktopFeishuRegistrationSnapshot
  }
  [IpcChannels.connectionsRuntimeStart]: { args: []; result: ChannelRuntimeStatus }
  [IpcChannels.connectionsRuntimeStop]: { args: []; result: ChannelRuntimeStatus }

  [IpcChannels.sessionBootstrap]: { args: []; result: DesktopBootstrapData }
  [IpcChannels.sessionList]: { args: []; result: DesktopSessionLists }
  [IpcChannels.sessionDaemonStatus]: { args: []; result: DesktopDaemonStatus }
  [IpcChannels.sessionChooseProject]: { args: []; result: DesktopProjectDetails | null }
  [IpcChannels.sessionInspectProject]: {
    args: [path: string]
    result: DesktopProjectDetails
  }
  [IpcChannels.sessionListCommands]: {
    args: [cwd: string]
    result: DesktopCommandCatalogEntry[]
  }
  [IpcChannels.sessionListContextPlugins]: {
    args: [cwd: string]
    result: DesktopPluginCatalogEntry[]
  }
  [IpcChannels.sessionCompact]: {
    args: [input: CompactDesktopSessionInput]
    result: DesktopCompactSessionResult
  }
  [IpcChannels.sessionGoalGet]: {
    args: [input: GetDesktopSessionGoalInput]
    result: SessionGoal | null
  }
  [IpcChannels.sessionGoalCreate]: {
    args: [input: CreateDesktopSessionGoalInput]
    result: SessionGoal
  }
  [IpcChannels.sessionGoalUpdate]: {
    args: [input: UpdateDesktopSessionGoalInput]
    result: SessionGoal
  }
  [IpcChannels.sessionGoalAction]: {
    args: [input: DesktopSessionGoalActionInput]
    result: SessionGoal
  }
  [IpcChannels.projectRename]: {
    args: [input: RenameDesktopProjectInput]
    result: DesktopProjectDetails["project"]
  }
  [IpcChannels.projectSetPinned]: {
    args: [input: PinDesktopProjectInput]
    result: DesktopProjectDetails["project"]
  }
  [IpcChannels.projectSetDefaultShell]: {
    args: [input: SetDefaultDesktopProjectShellInput]
    result: DesktopProjectDetails["project"]
  }
  [IpcChannels.projectRemove]: { args: [path: string]; result: void }
  [IpcChannels.projectRebind]: {
    args: [projectId: string]
    result: DesktopProjectDetails["project"] | null
  }
  [IpcChannels.projectCheckoutBranch]: {
    args: [input: CheckoutDesktopProjectBranchInput]
    result: DesktopProjectDetails
  }
  [IpcChannels.projectCreateBranch]: {
    args: [input: CreateDesktopProjectBranchInput]
    result: DesktopProjectDetails
  }
  [IpcChannels.sessionCreate]: {
    args: [input: CreateDesktopSessionInput]
    result: DesktopSessionRecord
  }
  [IpcChannels.sessionOpen]: { args: [sessionId: string]; result: DesktopSessionView }
  [IpcChannels.activityOpen]: { args: []; result: DesktopActivityUpdate }
  [IpcChannels.sessionAuxOpen]: {
    args: [input: OpenDesktopAuxSessionInput]
    result: DesktopSessionView
  }
  [IpcChannels.sessionAuxClose]: { args: [input: CloseDesktopAuxSessionInput]; result: void }
  [IpcChannels.sessionFork]: {
    args: [input: ForkDesktopSessionInput]
    result: DesktopSessionRecord
  }
  [IpcChannels.sessionClose]: { args: []; result: void }
  [IpcChannels.sessionSendPrompt]: { args: [input: SendDesktopPromptInput]; result: void }
  [IpcChannels.sessionEditLatestPrompt]: {
    args: [input: EditLatestDesktopPromptInput]
    result: void
  }
  [IpcChannels.sessionPromoteQueuedPrompt]: {
    args: [input: PromoteDesktopQueuedPromptInput]
    result: void
  }
  [IpcChannels.sessionCancelQueuedPrompt]: {
    args: [input: CancelDesktopQueuedPromptInput]
    result: void
  }
  [IpcChannels.sessionInterrupt]: { args: [input: InterruptDesktopSessionInput]; result: void }
  [IpcChannels.sessionReplyPermission]: {
    args: [input: ReplyDesktopPermissionInput]
    result: void
  }
  [IpcChannels.sessionSetDefaultModel]: {
    args: [input: SetDefaultDesktopModelInput]
    result: DesktopBootstrapData
  }
  [IpcChannels.sessionSetDefaultPermissionMode]: {
    args: [input: SetDefaultDesktopPermissionModeInput]
    result: DesktopBootstrapData
  }
  [IpcChannels.sessionUpdateModel]: {
    args: [input: UpdateDesktopSessionModelInput]
    result: DesktopSessionRecord
  }
  [IpcChannels.sessionUpdatePermissionMode]: {
    args: [input: UpdateDesktopSessionPermissionModeInput]
    result: DesktopSessionRecord
  }
  [IpcChannels.sessionUpdateEffort]: {
    args: [input: UpdateDesktopSessionEffortInput]
    result: DesktopSessionRecord
  }
  [IpcChannels.sessionGetContextUsage]: {
    args: [input: GetDesktopContextUsageInput]
    result: DesktopContextUsageSnapshot
  }
  [IpcChannels.sessionRename]: {
    args: [input: RenameDesktopSessionInput]
    result: DesktopSessionRecord
  }
  [IpcChannels.sessionSetPinned]: {
    args: [input: PinDesktopSessionInput]
    result: DesktopSessionRecord
  }
  [IpcChannels.sessionArchive]: {
    args: [sessionId: string]
    result: DesktopSessionRecord
  }
  [IpcChannels.sessionDelete]: {
    args: [sessionId: string]
    result: string[]
  }

  [IpcChannels.attachmentPickFiles]: { args: []; result: DesktopAttachmentCandidate[] }
  [IpcChannels.attachmentPickImages]: { args: []; result: DesktopAttachmentCandidate[] }
  [IpcChannels.attachmentStageDropped]: {
    args: [paths: string[]]
    result: DesktopAttachmentCandidate[]
  }
  [IpcChannels.attachmentUploadMemory]: {
    args: [input: UploadDesktopAttachmentMemoryInput]
    result: { taskId: string }
  }
  [IpcChannels.attachmentStartUpload]: {
    args: [input: StartDesktopAttachmentUploadInput]
    result: { taskId: string }
  }
  [IpcChannels.attachmentCancelUpload]: {
    args: [input: CancelDesktopAttachmentUploadInput]
    result: void
  }
  [IpcChannels.attachmentRetryUpload]: {
    args: [input: RetryDesktopAttachmentUploadInput]
    result: { taskId: string }
  }
  [IpcChannels.attachmentDiscardDraft]: {
    args: [input: DiscardDesktopAttachmentDraftInput]
    result: void
  }
  [IpcChannels.attachmentDeleteUnreferenced]: {
    args: [input: DesktopAttachmentAssetInput]
    result: { deleted: boolean; inUse: boolean }
  }
  [IpcChannels.attachmentReadPreview]: {
    args: [input: DesktopAttachmentAssetInput]
    result: DesktopAttachmentPreview
  }
  [IpcChannels.attachmentOpen]: {
    args: [input: DesktopAttachmentAssetInput]
    result: void
  }
  [IpcChannels.attachmentSaveAs]: {
    args: [input: DesktopAttachmentAssetInput]
    result: { saved: boolean }
  }
  [IpcChannels.attachmentStorageScan]: { args: []; result: AttachmentStorageReport }
  [IpcChannels.attachmentStorageRepair]: { args: []; result: AttachmentStorageRepairResult }
  [IpcChannels.attachmentStorageGc]: { args: []; result: AttachmentStorageGcResult }

  [IpcChannels.workspaceListFiles]: {
    args: [input: WorkspaceListFilesInput]
    result: WorkspaceListFilesResult
  }
  [IpcChannels.workspaceReadFile]: {
    args: [input: WorkspaceReadFileInput]
    result: WorkspaceReadFileResult
  }
  [IpcChannels.workspaceRevealPath]: {
    args: [input: WorkspaceRevealPathInput]
    result: void
  }
  [IpcChannels.workspaceCopyPath]: {
    args: [input: WorkspaceCopyPathInput]
    result: string
  }
  [IpcChannels.workspaceListOpeners]: {
    args: []
    result: WorkspaceOpener[]
  }
  [IpcChannels.workspaceOpenWith]: {
    args: [input: WorkspaceOpenWithInput]
    result: void
  }

  [IpcChannels.gitChanges]: {
    args: [input: DesktopGitChangesInput]
    result: DesktopGitChangesResult
  }
  [IpcChannels.gitFileDiff]: {
    args: [input: DesktopGitFileDiffInput]
    result: DesktopGitFileDiffResult
  }
  [IpcChannels.gitIsRepository]: {
    args: [input: DesktopGitIsRepositoryInput]
    result: DesktopGitIsRepositoryResult
  }

  [IpcChannels.clipboardReadText]: {
    args: []
    result: string
  }
  [IpcChannels.clipboardWriteText]: {
    args: [text: string]
    result: void
  }

  [IpcChannels.terminalCreate]: {
    args: [input: DesktopTerminalCreateInput]
    result: DesktopTerminalRecord
  }
  [IpcChannels.terminalWrite]: {
    args: [input: DesktopTerminalWriteInput]
    result: void
  }
  [IpcChannels.terminalResize]: {
    args: [input: DesktopTerminalResizeInput]
    result: void
  }
  [IpcChannels.terminalRead]: {
    args: [input: DesktopTerminalReadInput]
    result: DesktopTerminalReadResult
  }
  [IpcChannels.terminalKill]: {
    args: [terminalId: string]
    result: void
  }
  [IpcChannels.terminalList]: {
    args: []
    result: DesktopTerminalRecord[]
  }
  [IpcChannels.terminalListShells]: {
    args: []
    result: DesktopDetectedTerminalShell[]
  }
  [IpcChannels.scheduleStatus]: { args: []; result: DesktopScheduledStatus }
  [IpcChannels.scheduleList]: { args: []; result: DesktopScheduledTask[] }
  [IpcChannels.scheduleCreate]: {
    args: [input: CreateDesktopScheduledTaskInput]
    result: DesktopScheduledTask
  }
  [IpcChannels.scheduleUpdate]: {
    args: [id: string, input: UpdateDesktopScheduledTaskInput]
    result: DesktopScheduledTask
  }
  [IpcChannels.scheduleRemove]: { args: [id: string]; result: void }
  [IpcChannels.scheduleRunNow]: { args: [id: string]; result: DesktopScheduledRun }
  [IpcChannels.scheduleListRuns]: {
    args: [input: ListDesktopScheduledRunsInput]
    result: DesktopScheduledRun[]
  }
  [IpcChannels.scheduleSetRunUnread]: {
    args: [id: string, unread: boolean]
    result: DesktopScheduledRun
  }
  [IpcChannels.providerSnapshot]: { args: []; result: DesktopProviderSnapshot }
  [IpcChannels.providerConnect]: {
    args: [input: ConnectDesktopProviderInput]
    result: DesktopProviderSnapshot
  }
  [IpcChannels.providerActivate]: {
    args: [input: ActivateDesktopProviderInput]
    result: DesktopProviderSnapshot
  }
  [IpcChannels.providerDisconnect]: {
    args: [input: DisconnectDesktopProviderInput]
    result: DesktopProviderSnapshot
  }
  [IpcChannels.providerCatalogHeadersUpdate]: {
    args: [input: UpdateDesktopCatalogProviderHeadersInput]
    result: DesktopProviderSnapshot
  }
  [IpcChannels.providerCustomCreate]: {
    args: [input: CreateDesktopCustomProviderInput]
    result: DesktopProviderSnapshot
  }
  [IpcChannels.providerCustomUpdate]: {
    args: [input: UpdateDesktopCustomProviderInput]
    result: DesktopProviderSnapshot
  }
  [IpcChannels.providerCustomRemove]: {
    args: [input: RemoveDesktopCustomProviderInput]
    result: DesktopProviderSnapshot
  }
  [IpcChannels.pluginSnapshot]: {
    args: [input: DesktopPluginContextInput]
    result: DesktopPluginSnapshot
  }
  [IpcChannels.pluginEnable]: {
    args: [input: DesktopPluginActionInput]
    result: DesktopPluginSnapshot
  }
  [IpcChannels.pluginDisable]: {
    args: [input: DesktopPluginActionInput]
    result: DesktopPluginSnapshot
  }
  [IpcChannels.pluginUninstall]: {
    args: [input: DesktopPluginActionInput]
    result: DesktopPluginSnapshot
  }
  [IpcChannels.pluginReload]: {
    args: [input: DesktopPluginContextInput]
    result: DesktopPluginSnapshot
  }
  [IpcChannels.pluginImportArchive]: {
    args: [input: DesktopPluginArchiveImportInput]
    result: DesktopPluginArchiveImportResult
  }
  [IpcChannels.pluginConfirmArchive]: {
    args: [input: DesktopPluginArchiveConfirmInput]
    result: DesktopPluginArchiveConfirmResult
  }
  [IpcChannels.pluginCancelArchive]: {
    args: [input: DesktopPluginArchiveCancelInput]
    result: void
  }
  [IpcChannels.pluginImportGit]: {
    args: [input: DesktopPluginGitImportInput]
    result: DesktopPluginGitImportResult
  }
  [IpcChannels.pluginConfirmGit]: {
    args: [input: DesktopPluginArchiveConfirmInput]
    result: DesktopPluginGitConfirmResult
  }
  [IpcChannels.pluginCancelGit]: {
    args: [input: DesktopPluginArchiveCancelInput]
    result: void
  }
  [IpcChannels.skillSnapshot]: {
    args: [input: DesktopSkillSnapshotInput]
    result: DesktopSkillSnapshot
  }
  [IpcChannels.skillRemove]: {
    args: [input: DesktopSkillRemoveInput]
    result: DesktopSkillSnapshot
  }
}
