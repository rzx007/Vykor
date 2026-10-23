export { type SessionStatus, type SessionStorage, type InputDelivery, type RunStatus, type RunAttemptStatus, type SessionTaskStatus, type PermissionStatus, type SessionMessageRole, type SessionMessagePartType, type SessionMessagePartStatus, type ProjectionSettlementAction, type ProjectionSettlementStatus, SESSION_EVENT_SCHEMA_VERSION, SESSION_EVENT_SCHEMA_VERSIONS, sessionEventSchemaVersion, type SessionRecord, type SearchSessionsOptions, type SessionSearchResult, getSessionStorage, type ProjectRecord, type ProjectLocationRecord, type SessionInputRecord, type SessionMessageRecord, type SessionMessagePartRecord, type SessionEventRecord, type SessionAttachmentMessagePartRecord, type SessionTransformationMessagePartRecord, type ProjectionSettlementRecord, type SessionRunRecord, type SessionRunAttemptRecord, type SessionExecutionRecord, type PermissionRequestRecord } from "@vykor/domain-contracts/sessions/records";
export { type SessionModelFailureKind, type SessionModelRetryState, type SessionModelGenerationMetadata, type SessionModelAttemptUsageStatus, type SessionModelAttemptUsageSnapshot, type SessionModelAttemptUsage, type SessionModelUsageSummary, settleSessionToolMetadata, readSessionModelRetryState, readModelGenerationMetadata, isSupersededModelPart, isCommittedModelPart, readSessionModelUsage, readSessionModelAttemptUsage } from "@vykor/domain-contracts/sessions/model-metadata";
import type { SessionRecord, SessionInputRecord, SessionMessageRecord, SessionMessagePartRecord, SessionRunRecord, SessionRunAttemptRecord, SessionExecutionRecord, PermissionRequestRecord } from "@vykor/domain-contracts/sessions";
/** Atomic, server-owned state used when a client attaches to one session. */
export interface SessionStateSnapshot {
  pluginApps?: import("../extensions/plugin-apps").PluginAppRecord[];
  cursor: number;
  session: SessionRecord;
  inputs: SessionInputRecord[];
  messages: SessionMessageRecord[];
  parts: SessionMessagePartRecord[];
  runs: SessionRunRecord[];
  attempts: SessionRunAttemptRecord[];
  tasks?: SessionExecutionRecord[];
  permissions: PermissionRequestRecord[];
}


export * from "../runtime/scheduled.js";
export * from "./session-requests.js";
