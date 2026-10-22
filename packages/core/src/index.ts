export type { QueryEngine as IQueryEngine, QueryEngineOptions, QueryRequestConfiguration, MemoryRetriever } from "./types/runtime";
export type { ModelRetryPolicy, RetryCounters, NextModelRetryDelayInput } from "./engine/model-retry";
export {
  DEFAULT_MODEL_RETRY_POLICY,
  normalizeModelRetryPolicy,
  nextModelRetryDelay,
  waitForModelRetry,
} from "./engine/model-retry";
export {
  streamBufferedModelWithRetry,
  type BufferedModelRetryOptions,
} from "./engine/buffered-model-retry";

export { formatToolResultForModel, toolFeedbackFields, externalToolMetadata, validHostFileFacts } from "./engine/tool-result-feedback";
export { toolDefinitionIdentity } from "./engine/tool-definition-identity";

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
export { ToolRegistry, ToolRegistrationError, resolveToolExecution, isToolVisibleTo } from "./engine/tool-registry";
export {
  CompactService,
  type CompactContext,
  type CompactContextSection,
  type CompactContextProvider,
} from "./engine/compact-service";
export { CostTracker } from "./engine/cost-tracker";


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
  sanitizeMessageHistory,
  boundaryFallsInsideToolGroup,
  toolUseIds,
  toolResultId,
  isToolResultMessage,
} from "./utils/message-history";
