/** Agent lifecycle SDK for an existing Vykor daemon. Browser-safe; no application business APIs. */
export {
  VykorClient, HttpTransport, SseTransport, VykorApiError, normalizeDaemonBaseUrl,
  streamServerSentEvents, attachmentRangeHeader, responseArray, responseField,
} from "./transport/index.js";
export type { HttpTransportOptions, HttpRequestOptions, RawRequestOptions } from "./transport/index.js";
export { ProtocolClient, IncompatibleProtocolError } from "./protocol/index.js";
export { RuntimeResource, SessionResource, AttachmentResource, PermissionResource, JobResource, EventResource, FilesResource, createPromptRequestId } from "./resources/index.js";
export * from "./state/index.js";
export type * from "./types/index.js";
export { normalizeApprovalMode, isWorkMode, patchSessionRuntimeMetadata, readSessionRuntimeConfig } from "./configuration/runtime-configuration.js";
export {
  CURRENT_PROTOCOL_VERSION, checkProtocolCompatibility, supportsFeature, ProtocolValidationError,
  parseCreateSessionGoalInput, parseUpdateSessionGoalInput, parseGoalActionInput,
  readSessionModelRetryState, readSessionModelUsage, isSupersededModelPart,
  readWorkspaceChangesMetadata, readRuntimeMetadata,
} from "@vykor/protocol";
export type {
  ApprovalMode, WorkMode, ApprovalReviewRecord, SessionRuntimeConfig, SessionRuntimeConfigPatch,
  AgentEnvironmentCapabilities, ClientProtocolSupport, ProtocolCompatibility, ServerCapabilities,
  SessionModelRetryState, SessionModelUsageSummary, WorkspaceChangesMetadata, WorkspaceChangeFile,
  SearchSessionsOptions, SessionSearchResult, JsonValue,
  JobCapabilities, JobTarget, JobInputReceipt, JobListResult, JobKind, JobReadResult, JobStatus, JobWaitResult,
} from "@vykor/protocol";
