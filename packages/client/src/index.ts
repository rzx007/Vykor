/**
 * @rzx/client 公共导出。
 *
 * 面向 TUI / Web / Desktop：typed HTTP API、SSE 解析、事件 reducer、replay+live 同步。
 * 客户端只做展示与控制，不拥有 agent runtime。
 */

export {
  createPromptRequestId,
  normalizeDaemonBaseUrl,
  VykorApiError,
  IncompatibleProtocolError,
  VykorClient,
  streamServerSentEvents,
  HttpTransport,
  SseTransport,
} from "./transport/index.js";
export {
  ProtocolClient,
} from "./protocol/index.js";
export type { DaemonRestartPreview } from "./resources/configuration/system-resource.js";
export {
  SystemResource,
  ProviderResource,
  AuthResource,
  ProjectResource,
  PluginResource,
  PluginUiHistoryResource,
  DevelopmentResource,
  SessionResource,
  AttachmentResource,
  PermissionResource,
  ScheduleResource,
  NoteResource,
  JobResource,
  TerminalResource,
  ChannelResource,
  EventResource,
  McpResource,
} from "./resources/index.js";
export { parseCreateSessionGoalInput, parseUpdateSessionGoalInput, parseGoalActionInput } from "@vykor/protocol";
export { normalizeApprovalMode, isWorkMode, patchSessionRuntimeMetadata, readSessionRuntimeConfig } from "./configuration/runtime-configuration.js";
export type { ApprovalMode, WorkMode, ApprovalReviewRecord } from "@vykor/protocol";
export { readWorkspaceChangesMetadata } from "@vykor/protocol";
export type { UsageFilter, UsageRequest, UsagePrice, UsageSettings, UsageReport, StorageCategory, StorageReport, CleanupCandidate, CleanupPreview, CleanupResult, MaintenanceBackupManifest, StorageRetentionPolicy } from "@vykor/protocol";
export type { WorkspaceChangesMetadata, WorkspaceChangeFile } from "@vykor/protocol";
export type { PluginCatalogEntry, AgentEnvironmentCapabilities, AttachmentAssetRecord, CreateNoteInput, NoteRecord, UpdateNoteInput, ClientProtocolSupport, ProtocolCompatibility, ServerCapabilities, SearchSessionsOptions, SessionSearchResult } from "@vykor/protocol";
export { checkProtocolCompatibility, CURRENT_PROTOCOL_VERSION, readSessionModelRetryState, readSessionModelUsage, isSupersededModelPart, supportsFeature } from "@vykor/protocol";
export type { SessionModelRetryState, SessionModelUsageSummary } from "@vykor/protocol";
export {
  applyEvent,
  applyEvents,
  applySessionSnapshot,
  createInitialClientState,
  hydrateState,
  selectFirstPendingPermission,
  selectSessionInputs,
  selectSessionMessagesWithParts,
  selectSessionModelRetry,
  selectSessionModelUsage,
  selectSessionOrderedMessages,
  selectSessionParts,
  selectSessionPermissions,
  selectSessionRuns,
  selectSessionTasks,
  selectVisibleSessionMessagesWithParts,
  SessionSyncController,
  syncEvents,
  UnsupportedSessionEventSchemaVersionError,
} from "./state/index.js";
export type {
  SessionSyncControllerOptions,
  SyncConnectionStatus,
} from "./state/index.js";
export {
  LOCAL_COMMAND_DETAILS,
  LOCAL_COMMAND_NAMES,
  dispatchSessionCommand,
  hasActiveRun,
  mergeCommandDetails,
  parseSlashLine,
  resolveSessionCwd,
} from "./commands/index.js";
export { isPluginIconSource, isPluginWebUrl, readRuntimeMetadata } from "@vykor/protocol";
export type { SessionRuntimeConfig, SessionRuntimeConfigPatch } from "@vykor/protocol";
export type {
  PresentationReadRequest,
  SessionCommandHost,
  SessionCommandOutcome,
  SlashLine,
} from "./commands/index.js";
export type {
  AdmitClientPromptInput,
  AgentPersonaInfo,
  AttachmentStorageGcResult,
  AttachmentStorageIssue,
  AttachmentStorageRepairResult,
  AttachmentStorageReport,
  AuthStatus,
  CommandCatalogEntry,
  CommandKind,
  CommandSelection,
  CommandSource,
  CompactSessionResponse,
  CancelQueuedClientPromptInput,
  CancelQueuedPromptResponse,
  CreateBackgroundShellInput,
  CreateBackgroundShellResult,
  CreateScheduledTaskInput,
  AdmitPromptAttachmentInput,
  CreateClientSessionInput,
  EditLatestClientPromptInput,
  EventSyncOptions,
  ForkClientSessionInput,
  HookInfo,
  ReloadPluginsResponse,
  RewindSessionResponse,
  InputDelivery,
  InterruptSessionResponse,
  ListClientMessagePartsOptions,
  ListCommandsOptions,
  ListEventsOptions,
  ListMessagesOptions,
  ListPermissionsOptions,
  ListSessionsOptions,
  ListProjectsOptions,
  ProjectRecord,
  McpServerStatus,
  McpRuntimeStatus,
  McpRuntimeSyncResult,
  MemoryEntryRecord,
  MemoryRevision,
  UpdateMemoryEntryInput,
  ClearMemoryInput,
  ClearSessionWorktreeBindingInput,
  MemoryListResponse,
  ModelInfo,
  ModelProviderInfo,
  VykorClientOptions,
  VykorClientState,
  VykorServerHealth,
  OutputStyleInfo,
  PermissionRequestRecord,
  PermissionStatus,
  PluginInfo,
  PluginUiInventory,
  PluginRuntimeStatus,
  SkillInfo,
  SkillProject,
  SkillSnapshot,
  SkillSource,
  PromoteQueuedClientPromptInput,
  PromoteQueuedPromptResponse,
  PromptResponse,
  ProviderInfo,
  CustomProviderInput,
  ConnectCatalogProviderInput,
  UpdateCatalogProviderHeadersInput,
  RememberSessionResponse,
  ReplyPermissionInput,
  ScheduledRunRecord,
  ScheduledTaskRecord,
  ScheduledTaskStatusSummary,
  SessionBucket,
  UpdateScheduledTaskInput,
  SessionEventRecord,
  SessionAttachmentMessagePartRecord,
  SessionInputAttachmentRecord,
  SessionExportResponse,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionRunAttemptRecord,
  SessionExecutionRecord,
  SessionStateSnapshot,
  SessionTransformationMessagePartRecord,
  SessionUserInputItem,
  SessionGoal,
  CreateSessionGoalInput,
  UpdateSessionGoalInput,
  GoalActionInput,
  SessionUsageResponse,
  StartDreamResponse,
  SyncEventUpdate,
  UpdateClientSessionInput,
  UploadAttachmentInput,
  DownloadAttachmentOptions,
} from "./types/index.js";
export type { SessionMessageWithParts } from "./state/index.js";
export type { TerminalCreateRequest, TerminalEvent, TerminalReadRequest, TerminalReadResult, TerminalResizeRequest, TerminalRuntime, TerminalSessionInfo, TerminalSessionStatus, TerminalSignal, TerminalSource, TerminalWriteRequest, JobCapabilities, JobTarget, JobInputReceipt, JobListResult, JobKind, JobReadResult, JobSnapshot, JobStatus, JobWaitResult, DurableChannelMessageInput, DurableChannelMessageResult, ExternalConversationRecord, ChannelDeliveryRecord, ChannelDeliveryStatus, ChannelStatusSnapshot, ChannelConnectorRuntimeStatus, ChannelDenialNotice, ChannelDomain, ChannelRuntimeControlInput, ChannelRuntimeState, ChannelRuntimeStatus, FeishuAllowInput, FeishuChannelSnapshot, FeishuConnectInput, FeishuPatchInput, FeishuRegistrationSnapshot, FeishuRegistrationStartInput, FeishuRegistrationState, RecordChannelDeliveryInput } from "@vykor/protocol";

export type { GoalStopReason, GoalExternalWait } from "@vykor/protocol";

export { officeFormat, OFFICE_MEDIA_TYPES } from "@vykor/protocol";
export type { OfficeFormat, OfficePreview } from "@vykor/protocol";

export { PluginAppResource } from "./resources/plugins/plugin-app-resource.js";
export { getPluginAppToolPolicy } from "./resources/plugins/plugin-app-policy.js";
export type { PluginAppToolPolicy, PluginAppToolDescriptor } from "@vykor/protocol";
export type { PluginAppToolRequest, PluginAppConversationRequest, PluginAppActionResponse, PluginAppActionReceipt, PluginAppSubmissionReceipt, PluginAppRecord, PluginAppSource, PluginAppRuntimeLease, PluginAppResponse } from "@vykor/protocol";
export { PLUGIN_APP_INPUT_LIMITS, PLUGIN_APP_DATA_LIMITS, PLUGIN_APP_RESOURCE_LIMITS, parsePluginAppConversationRequest, copyPluginAppJson, parseOpenPluginAppInput, parsePluginAppSource, parsePluginAppToolRequest } from "@vykor/protocol";
export { parseMcpCallResultData } from "@vykor/protocol";
export { isPluginAppAdmissionRejection, type PluginAppAdmissionRejection } from "@vykor/protocol";

export { readPluginUiInstance, readPluginUiAction, parsePluginUiSubmissionRecord, parsePluginUiConversationReceipt, ProtocolValidationError } from "@vykor/protocol";
export type { JsonValue, PluginUiInstanceRecord, PluginUiActionRunMetadata, PluginUiActionReceipt, PluginUiActionResponse, PluginUiSubmissionRecord, PluginUiConversationReceipt } from "@vykor/protocol";

export type { MarketplaceCatalog, MarketplaceSource, MarketplaceSourceView, MarketplaceEntry, MarketplaceSelection, MarketplacePreview, MarketplaceInstallInput, MarketplaceOperation, MarketplaceProvenance } from "./types/extension-types.js";
