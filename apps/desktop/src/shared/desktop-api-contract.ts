import type {
  DesktopAppInfo,
  PetState,
  PlatformInfo,
  TrayNotificationOptions,
} from "./ipc-channels"
import type {
  CheckoutDesktopProjectBranchInput,
  CreateDesktopSessionInput,
  CreateDesktopProjectBranchInput,
  DesktopBootstrapData,
  DesktopAuxSessionUpdate,
  DesktopCommandCatalogEntry,
  DesktopPluginCatalogEntry,
  CompactDesktopSessionInput,
  DesktopCompactSessionResult,
  DesktopDaemonStatus,
  DesktopProjectDetails,
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
  RenameDesktopProjectInput,
  RenameDesktopSessionInput,
  ReplyDesktopPermissionInput,
  SetDefaultDesktopProjectShellInput,
  SendDesktopPromptInput,
  SetDefaultDesktopModelInput,
  SetDefaultDesktopPermissionModeInput,
  GetDesktopSessionGoalInput,
  CreateDesktopSessionGoalInput,
  UpdateDesktopSessionGoalInput,
  DesktopSessionGoalActionInput,
  SessionGoal,
  UpdateDesktopSessionModelInput,
  UpdateDesktopSessionPermissionModeInput,
  GetDesktopContextUsageInput,
} from "./session-types"
import type { DesktopContextUsageSnapshot } from "./context-usage-types"
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
  DesktopTerminalEvent,
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
} from "./git-types"
import type {
  DesktopPluginActionInput,
  DesktopPluginArchiveCancelInput,
  DesktopPluginArchiveConfirmResult,
  DesktopPluginArchiveConfirmInput,
  DesktopPluginArchiveImportInput,
  DesktopPluginArchiveImportResult,
  DesktopPluginGitConfirmResult,
  DesktopPluginGitImportInput,
  DesktopPluginGitImportResult,
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
  DesktopAttachmentUploadEvent,
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

export type DesktopAPI = {
  app: {
    getInfo: () => Promise<DesktopAppInfo>
    getPlatform: () => Promise<PlatformInfo>
    quit: () => Promise<void>
  }
  updates: {
    getState: () => Promise<DesktopUpdateState>
    download: () => Promise<void>
    install: () => Promise<void>
    onStateChanged: (listener: (state: DesktopUpdateState) => void) => () => void
  }
  window: {
    showMain: () => Promise<void>
    minimize: () => Promise<void>
    close: () => Promise<void>
    toggleMaximize: () => Promise<void>
    isMaximized: () => Promise<boolean>
    getZoomLevel: () => Promise<number>
    setZoomLevel: (level: number) => Promise<number>
    openExternal: (url: string) => Promise<void>
    onMaximizedChanged: (listener: (value: boolean) => void) => () => void
  }
  tray: {
    flash: () => Promise<void>
    stopFlash: () => Promise<void>
    notify: (options: TrayNotificationOptions) => Promise<void>
  }
  pet: {
    show: () => Promise<void>
    hide: () => Promise<void>
    toggle: () => Promise<PetState>
    getState: () => Promise<PetState>
    setAlwaysOnTop: (value: boolean) => Promise<PetState>
    setIgnoreMouseEvents: (value: boolean) => Promise<PetState>
    onClicked: (listener: () => void) => () => void
  }
  workspace: {
    listFiles: (input: WorkspaceListFilesInput) => Promise<WorkspaceListFilesResult>
    readFile: (input: WorkspaceReadFileInput) => Promise<WorkspaceReadFileResult>
    revealPath: (input: WorkspaceRevealPathInput) => Promise<void>
    copyPath: (input: WorkspaceCopyPathInput) => Promise<string>
    listOpeners: () => Promise<WorkspaceOpener[]>
    openWith: (input: WorkspaceOpenWithInput) => Promise<void>
  }
  git: {
    changes: (input: DesktopGitChangesInput) => Promise<DesktopGitChangesResult>
    fileDiff: (input: DesktopGitFileDiffInput) => Promise<DesktopGitFileDiffResult>
  }
  clipboard: {
    readText: () => Promise<string>
    writeText: (text: string) => Promise<void>
  }
  attachments: {
    pickFiles: () => Promise<DesktopAttachmentCandidate[]>
    pickImages: () => Promise<DesktopAttachmentCandidate[]>
    stageDroppedFiles: (files: readonly File[]) => Promise<DesktopAttachmentCandidate[]>
    uploadClipboardImage: (input: UploadDesktopAttachmentMemoryInput) => Promise<{ taskId: string }>
    startUpload: (input: StartDesktopAttachmentUploadInput) => Promise<{ taskId: string }>
    cancelUpload: (input: CancelDesktopAttachmentUploadInput) => Promise<void>
    retryUpload: (input: RetryDesktopAttachmentUploadInput) => Promise<{ taskId: string }>
    discardDraft: (input: DiscardDesktopAttachmentDraftInput) => Promise<void>
    deleteUnreferenced: (
      input: DesktopAttachmentAssetInput
    ) => Promise<{ deleted: boolean; inUse: boolean }>
    readPreview: (input: DesktopAttachmentAssetInput) => Promise<DesktopAttachmentPreview>
    open: (input: DesktopAttachmentAssetInput) => Promise<void>
    saveAs: (input: DesktopAttachmentAssetInput) => Promise<{ saved: boolean }>
    scanStorage: () => Promise<AttachmentStorageReport>
    repairStorage: () => Promise<AttachmentStorageRepairResult>
    gcStorage: () => Promise<AttachmentStorageGcResult>
    onUploadEvent: (listener: (event: DesktopAttachmentUploadEvent) => void) => () => void
  }
  terminal: {
    create: (input: DesktopTerminalCreateInput) => Promise<DesktopTerminalRecord>
    write: (input: DesktopTerminalWriteInput) => Promise<void>
    resize: (input: DesktopTerminalResizeInput) => Promise<void>
    read: (input: DesktopTerminalReadInput) => Promise<DesktopTerminalReadResult>
    kill: (terminalId: string) => Promise<void>
    list: () => Promise<DesktopTerminalRecord[]>
    listShells: () => Promise<DesktopDetectedTerminalShell[]>
    onEvent: (listener: (event: DesktopTerminalEvent) => void) => () => void
  }
  schedules: {
    status: () => Promise<DesktopScheduledStatus>
    list: () => Promise<DesktopScheduledTask[]>
    create: (input: CreateDesktopScheduledTaskInput) => Promise<DesktopScheduledTask>
    update: (id: string, input: UpdateDesktopScheduledTaskInput) => Promise<DesktopScheduledTask>
    remove: (id: string) => Promise<void>
    runNow: (id: string) => Promise<DesktopScheduledRun>
    listRuns: (input: ListDesktopScheduledRunsInput) => Promise<DesktopScheduledRun[]>
    setRunUnread: (id: string, unread: boolean) => Promise<DesktopScheduledRun>
  }
  providers: {
    snapshot: () => Promise<DesktopProviderSnapshot>
    connect: (input: ConnectDesktopProviderInput) => Promise<DesktopProviderSnapshot>
    activate: (input: ActivateDesktopProviderInput) => Promise<DesktopProviderSnapshot>
    disconnect: (input: DisconnectDesktopProviderInput) => Promise<DesktopProviderSnapshot>
    updateCatalogHeaders: (
      input: UpdateDesktopCatalogProviderHeadersInput
    ) => Promise<DesktopProviderSnapshot>
    createCustom: (input: CreateDesktopCustomProviderInput) => Promise<DesktopProviderSnapshot>
    updateCustom: (input: UpdateDesktopCustomProviderInput) => Promise<DesktopProviderSnapshot>
    removeCustom: (input: RemoveDesktopCustomProviderInput) => Promise<DesktopProviderSnapshot>
  }
  mcp: {
    snapshot: () => Promise<DesktopMcpSnapshot>
    login: (input: DesktopMcpLoginInput) => Promise<DesktopMcpSnapshot>
    logout: (input: DesktopMcpLogoutInput) => Promise<DesktopMcpSnapshot>
  }
  connections: {
    snapshot: () => Promise<DesktopConnectionsSnapshot>
    runtimeStatus: () => Promise<DesktopRuntimeDelta>
    connect: (
      input: DesktopFeishuConnectInput
    ) => Promise<{ feishu: FeishuChannelSnapshot; runtime: ChannelRuntimeStatus }>
    patch: (
      input: DesktopFeishuPatchInput
    ) => Promise<{ feishu: FeishuChannelSnapshot; runtime: ChannelRuntimeStatus }>
    remove: () => Promise<{
      feishu: FeishuChannelSnapshot
      runtime: ChannelRuntimeStatus
    }>
    allowAdd: (input: DesktopFeishuAllowInput) => Promise<FeishuChannelSnapshot>
    allowRemove: (key: string) => Promise<FeishuChannelSnapshot>
    startRegistration: (
      input: DesktopFeishuRegistrationStartInput
    ) => Promise<DesktopFeishuRegistrationSnapshot>
    registrationStatus: () => Promise<DesktopFeishuRegistrationSnapshot>
    cancelRegistration: () => Promise<DesktopFeishuRegistrationSnapshot>
    startRuntime: () => Promise<ChannelRuntimeStatus>
    stopRuntime: () => Promise<ChannelRuntimeStatus>
  }
  settings: {
    snapshot: () => Promise<DesktopSettingsSnapshot>
    updateWorkStyle: (input: UpdateDesktopWorkStyleInput) => Promise<DesktopSettingsSnapshot>
    updateNotificationMode: (
      input: UpdateDesktopNotificationModeInput
    ) => Promise<DesktopSettingsSnapshot>
    updateAgentEnvironment: (
      input: UpdateDesktopAgentEnvironmentInput
    ) => Promise<DesktopSettingsSnapshot>
    updateDefaultOpener: (
      input: UpdateDesktopDefaultOpenerInput
    ) => Promise<DesktopSettingsSnapshot>
    updateDefaultTerminalShell: (
      input: UpdateDesktopDefaultTerminalShellInput
    ) => Promise<DesktopSettingsSnapshot>
  }
  daemonAutoStart: {
    snapshot: () => Promise<DesktopDaemonAutoStartSnapshot>
    enable: () => Promise<DesktopDaemonAutoStartSnapshot>
    disable: () => Promise<DesktopDaemonAutoStartSnapshot>
    dismissOnboarding: () => Promise<DesktopDaemonAutoStartSnapshot>
  }
  plugins: {
    snapshot: (input: DesktopPluginContextInput) => Promise<DesktopPluginSnapshot>
    enable: (input: DesktopPluginActionInput) => Promise<DesktopPluginSnapshot>
    disable: (input: DesktopPluginActionInput) => Promise<DesktopPluginSnapshot>
    uninstall: (input: DesktopPluginActionInput) => Promise<DesktopPluginSnapshot>
    reload: (input: DesktopPluginContextInput) => Promise<DesktopPluginSnapshot>
    importArchive: (
      input: DesktopPluginArchiveImportInput
    ) => Promise<DesktopPluginArchiveImportResult>
    confirmArchive: (
      input: DesktopPluginArchiveConfirmInput
    ) => Promise<DesktopPluginArchiveConfirmResult>
    cancelArchive: (input: DesktopPluginArchiveCancelInput) => Promise<void>
    importGit: (
      input: DesktopPluginGitImportInput
    ) => Promise<DesktopPluginGitImportResult>
    confirmGit: (
      input: DesktopPluginArchiveConfirmInput
    ) => Promise<DesktopPluginGitConfirmResult>
    cancelGit: (input: DesktopPluginArchiveCancelInput) => Promise<void>
  }
  skills: {
    snapshot: (input: DesktopSkillSnapshotInput) => Promise<DesktopSkillSnapshot>
    remove: (input: DesktopSkillRemoveInput) => Promise<DesktopSkillSnapshot>
  }
  sessions: {
    bootstrap: () => Promise<DesktopBootstrapData>
    list: () => Promise<DesktopSessionLists>
    daemonStatus: () => Promise<DesktopDaemonStatus>
    chooseProject: () => Promise<DesktopProjectDetails | null>
    inspectProject: (path: string) => Promise<DesktopProjectDetails>
    listCommands: (cwd: string) => Promise<DesktopCommandCatalogEntry[]>
    listContextPlugins: (cwd: string) => Promise<DesktopPluginCatalogEntry[]>
    compact: (input: CompactDesktopSessionInput) => Promise<DesktopCompactSessionResult>
    getGoal: (input: GetDesktopSessionGoalInput) => Promise<SessionGoal | null>
    createGoal: (input: CreateDesktopSessionGoalInput) => Promise<SessionGoal>
    updateGoal: (input: UpdateDesktopSessionGoalInput) => Promise<SessionGoal>
    goalAction: (input: DesktopSessionGoalActionInput) => Promise<SessionGoal>
    renameProject: (input: RenameDesktopProjectInput) => Promise<DesktopProjectDetails["project"]>
    setProjectPinned: (input: PinDesktopProjectInput) => Promise<DesktopProjectDetails["project"]>
    setProjectDefaultShell: (
      input: SetDefaultDesktopProjectShellInput
    ) => Promise<DesktopProjectDetails["project"]>
    removeProject: (path: string) => Promise<void>
    rebindProject: (projectId: string) => Promise<DesktopProjectDetails["project"] | null>
    checkoutBranch: (input: CheckoutDesktopProjectBranchInput) => Promise<DesktopProjectDetails>
    createBranch: (input: CreateDesktopProjectBranchInput) => Promise<DesktopProjectDetails>
    create: (input: CreateDesktopSessionInput) => Promise<DesktopSessionRecord>
    open: (sessionId: string) => Promise<DesktopSessionView>
    openAux: (input: OpenDesktopAuxSessionInput) => Promise<DesktopSessionView>
    closeAux: (input: CloseDesktopAuxSessionInput) => Promise<void>
    fork: (input: ForkDesktopSessionInput) => Promise<DesktopSessionRecord>
    close: () => Promise<void>
    sendPrompt: (input: SendDesktopPromptInput) => Promise<void>
    editLatestPrompt: (input: EditLatestDesktopPromptInput) => Promise<void>
    promoteQueuedPrompt: (input: PromoteDesktopQueuedPromptInput) => Promise<void>
    cancelQueuedPrompt: (input: CancelDesktopQueuedPromptInput) => Promise<void>
    interrupt: (input: InterruptDesktopSessionInput) => Promise<void>
    replyPermission: (input: ReplyDesktopPermissionInput) => Promise<void>
    setDefaultModel: (input: SetDefaultDesktopModelInput) => Promise<DesktopBootstrapData>
    setDefaultPermissionMode: (
      input: SetDefaultDesktopPermissionModeInput
    ) => Promise<DesktopBootstrapData>
    updateModel: (input: UpdateDesktopSessionModelInput) => Promise<DesktopSessionRecord>
    updatePermissionMode: (
      input: UpdateDesktopSessionPermissionModeInput
    ) => Promise<DesktopSessionRecord>
    getContextUsage: (input: GetDesktopContextUsageInput) => Promise<DesktopContextUsageSnapshot>
    rename: (input: RenameDesktopSessionInput) => Promise<DesktopSessionRecord>
    setPinned: (input: PinDesktopSessionInput) => Promise<DesktopSessionRecord>
    archive: (sessionId: string) => Promise<DesktopSessionRecord>
    delete: (sessionId: string) => Promise<string[]>
    onDaemonStatusChanged: (listener: (value: DesktopDaemonStatus) => void) => () => void
    onUpdated: (listener: (value: DesktopSessionView) => void) => () => void
    onAuxUpdated: (listener: (value: DesktopAuxSessionUpdate) => void) => () => void
  }
}
