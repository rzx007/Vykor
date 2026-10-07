export type {
  Message,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  AssistantMessagePhase,
  CompactRole,
  ToolResultMessage,
  TextBlock,
  ImageBlock,
  ImageSource,
  VisionImagePreparationMetadata,
  ToolUseBlock,
  ContentBlock,
} from "./types/messages";

export type {
  StreamEvent,
  TextDeltaEvent,
  ReasoningDeltaEvent,
  ReasoningSource,
  ToolUseStartEvent,
  ToolGenerationProgressEvent,
  ToolUseEndEvent,
  ErrorEvent,
  UsageEvent,
  CompleteEvent,
  GenerationStartedEvent,
  ModelRetryEvent,
  ModelAttemptFinishedEvent,
} from "./types/events";

export type {
  ModelFailureKind,
  ModelFailureInfo,
  GenerationIdentity,
  ModelRetryState,
  ModelRetryPolicy,
  RetryCounters,
  NextModelRetryDelayInput,
  ModelAttemptUsageStatus,
} from "./engine/model-retry";
export {
  ModelRequestFailure,
  DEFAULT_MODEL_RETRY_POLICY,
  normalizeModelRetryPolicy,
  nextModelRetryDelay,
  waitForModelRetry,
} from "./engine/model-retry";
export {
  streamBufferedModelWithRetry,
  type BufferedModelRetryOptions,
} from "./engine/buffered-model-retry";

export type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  ToolExecutionResult,
  ToolFailureKind,
  ToolExecutionState,
  ToolRegistrationSource,
  RegisteredToolInspection,
  McpAuthConfigureInput,
  McpAuthConfigureResult,
  McpAuthHost,
  AgentBackgroundShellHost,
  ShellOutputCapture,
  ShellOutputLogHost,
  ShellOutputLogStatus,
  ShellOutputLogPage,
  ShellOutputLogSearchResult,
  ToolRegistry as IToolRegistry,
  ToolRegistryView,
  ToolDescriptor,
  ToolExecutionSpec,
} from "./types/tools";

export { formatToolResultForModel, toolFeedbackFields, externalToolMetadata } from "./engine/tool-result-feedback";
export { readToolOutputInlineChars } from "./engine/query-tool-limits";
export { toolDefinitionIdentity } from "./engine/tool-definition-identity";

export type { StreamingMessageClient, StreamMessageParams } from "./types/client";

export type {
  PermissionMode,
  PermissionRule,
  PermissionDecision,
  PermissionChecker as IPermissionChecker,
} from "./types/permissions";
export { parsePermissionSettings } from "./config/permission-settings.js";
export { parseAgentEnvironmentSettings } from "./config/agent-environment-settings.js";

export type {
  HookEvent,
  HookType,
  HookDefinition,
  HookResult,
  CommandHookDefinition,
  HttpHookDefinition,
  PromptHookDefinition,
  AgentHookDefinition,
  HookExecutor as IHookExecutor,
} from "./types/hooks";

export { HOOK_EVENTS } from "./types/hooks";

export type {
  Settings,
  AgentEnvironmentSettings,
  McpServerConfig,
  McpRemoteServerConfig,
  McpStdioServerConfig,
  MemoryConfig,
  SandboxConfig,
  PermissionSettings,
  PathRuleConfig,
  DaemonConfig,
  AutoReviewSettings,
  CustomProviderSettings,
  CustomProviderModelSettings,
  InputSupport,
  ModelInputCapabilities,
  WorkStyle,
} from "./types/settings";

export type {
  McpOAuthSettings,
  McpOAuthAuthStatus,
  McpOAuthCredentialRecord,
  McpOAuthStoreFile,
  McpOAuthStoreFileV2,
  McpOAuthStoreFileAny,
  CredentialMutationContext,
  McpAuthMode,
  McpRuntimeStatus,
  McpServerIdentity,
  McpRuntimeSyncResult,
  McpAuthServerSnapshot,
  McpRuntimeConnectionCoordinator,
  ActiveMcpRuntimeHandle,
  McpRuntimeRegistry,
} from "./types/mcp-oauth";

export { createUnavailableMcpRuntimeCoordinator } from "./mcp-runtime-coordinator";

export type { UsageSnapshot, CostTracker as ICostTracker } from "./types/usage";

export type {
  QueryEngine as IQueryEngine,
  RunCapabilityView,
  RunPluginUiBinding,
  RunToolBinding,
  RunSkillBinding,
  RunMcpServerBinding,
  RunAgentBinding,
  QueryEngineOptions,
  MemoryRetriever,
  AgentChildController,
  AgentChildBudget,
  AgentChildBudgetDimension,
  AgentChildBudgetSnapshot,
  AgentChildDirectory,
  AgentChildHandle,
  AgentChildInput,
  AgentChildInvocation,
  AgentChildResult,
  AgentChildSpawnInput,
  ChildActivitySnapshot,
  ChildFailureKind,
  ChildPartialResult,
  AgentScheduleEffects,
  AgentScheduledRun,
  AgentScheduledTask,
  AgentScheduledTaskInput,
  AgentEffectContext,
  AgentEffects,
  AgentEvent,
  AgentEventContext,
  AgentEventInput,
  AgentEventListener,
  AgentEventSource,
  AgentEventSubscription,
  AgentExecutionContext,
  AgentRunContribution,
  AgentRunToolContribution,
  AgentInputReceipt,
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentRunHandle,
  AgentRunResult,
  AgentRunScope,
  AgentPostRunChildParent,
  AgentSerializedError,
  AgentSteerInput,
  AgentRequestConfiguration,
  AgentRequestConfigurationPatch,
  AgentRequestConfigurationSnapshot,
  AgentRequestConfigurationReader,
  AgentRequestConfigurationStore,
  QueryRequestConfiguration,
} from "./types/runtime";

export { AgentChildBudgetExceededError, ChildRunTerminationError } from "./types/runtime";

export { AgentRunNotAcceptingInputError, RuntimeBundle } from "./types/runtime";
export {
  applyTrajectoryTracker,
  createTrajectoryLoopControl,
  DefaultTrajectoryTracker,
} from "./engine/trajectory/tracker";
export type {
  TrajectoryCall,
  TrajectoryEvent,
  TrajectoryLoopControl,
  TrajectoryTracker,
} from "./engine/trajectory/tracker";
export {
  AgentSession,
  createAgentSession,
  type AgentSessionOptions,
  type AgentSessionSubmitOptions,
} from "./agent-session";

export { QueryEngine, MaxTurnsExceeded } from "./engine/query-engine";
export {
  executeCheckedTools,
  type CheckedToolExecutionOptions,
  type CheckedToolExecutionResult,
} from "./engine/checked-tool-execution";
export { ToolRegistry, ToolRegistrationError, resolveToolExecution } from "./engine/tool-registry";
export { RuntimeBuilder } from "./engine/runtime-builder";
export {
  CompactService,
  type CompactContext,
  type CompactContextSection,
  type CompactContextProvider,
} from "./engine/compact-service";
export { CostTracker } from "./engine/cost-tracker";

export {
  DEFAULT_OUTPUT_TOKEN_MAX,
  OUTPUT_TOKEN_CAP_RATIO,
  loadSettings,
  resolveOutputTokenCap,
  saveSettings,
  loadProjectSettings,
  saveProjectSettings,
  saveMcpServerConfig,
  loadMcpServerConfigSnapshot,
  type McpServerConfigSnapshot,
  withMcpServerOAuthScopes,
} from "./config/settings";
export {
  updateSettings,
  withSettingsFileLock,
  SettingsConflictError,
  SettingsLockTimeoutError,
  type SettingsLockOptions,
} from "./config/settings-mutation";
export {
  assertValidMcpServerConfig,
  McpServerConfigError,
} from "./config/mcp-config-validation";
export {
  PROJECT_CONFIG_DIR_NAME,
  resolvePaths,
  getConfigDir,
  getConfigFilePath,
  getProjectConfigDir,
  getProjectSettingsFilePath,
  getDataDir,
  getLogsDir,
  getSessionsDir,
  getTasksDir,
  getPluginsDir,
  getPluginCacheDir,
  getPluginDataDir,
  getPluginSourcesDir,
  getInstalledPluginStorePath,
  getSkillsDir,
  getMemoryDir,
  getProjectMemoryDir,
  getFeedbackDir,
  getCredentialsFilePath,
  getMcpOAuthFilePath,
  getChannelCredentialsFilePath,
  getChannelWorkspaceRoot,
  resolveChannelWorkspaceRoot,
} from "./config/paths";
export { resolveGitRepository, type GitRepositoryInfo } from "./config/git";

export type { AppState } from "./state/app-state";
export { AppStateStore } from "./state/state-store";

export { retryWithBackoff } from "./utils/retry";
export { estimateTokens } from "./utils/token-counter";
export {
  assembleContextUsageSnapshot,
  createTip,
  evaluateTips,
  formatContextUsageReport,
  messagesToLedgerSegments,
  toolSchemasToLedgerSegments,
} from "./context-budget";
export type {
  AssembleContextUsageInput,
  ContextBucketId,
  ContextLedgerSegment,
  ContextUsageBucket,
  ContextUsageSnapshot,
  ContextUsageSource,
  ContextUsageTip,
  ContextUsageTipCode,
  ModelSwitchContext,
  ToolSchemaInput,
  ToolSchemaKind,
} from "./context-budget";
export {
  assertNoRemovedLifecycleToolNames,
  canonicalToolName,
  canonicalToolNames,
  RESERVED_SHELL_TOOL_NAMES,
  normalizeToolName,
  normalizeToolNames,
  resolveAllowedToolNames,
} from "./utils/tool-names";
export {
  sanitizeMessageHistory,
  boundaryFallsInsideToolGroup,
  toolUseIds,
  toolResultId,
  isToolResultMessage,
} from "./utils/message-history";
