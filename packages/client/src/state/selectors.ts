/**
 * Read-only selectors over the reducer state.
 *
 * These stay UI-agnostic so TUI/Web/Desktop can share the canonical
 * message/part view and map it to their own presentation models.
 */

import {
  isSupersededModelPart,
  readSessionModelRetryState,
  readSessionModelUsage,
  type SessionModelRetryState,
  type SessionModelUsageSummary,
} from "@vykor/protocol";
import type { SessionBucket, SessionMessagePartRecord, SessionMessageRecord } from "../types/index.js";

export interface SessionMessageWithParts {
  message: SessionMessageRecord;
  parts: SessionMessagePartRecord[];
}
export function selectSessionMessagesWithParts(
  bucket: SessionBucket | undefined,
): SessionMessageWithParts[] {
  if (!bucket) return [];
  return [...bucket.messages]
    .sort((a, b) => a.seq - b.seq)
    .map((message) => ({
      message,
      parts: [...(bucket.partsByMessageId[message.id] ?? [])].sort((a, b) => a.seq - b.seq),
    }));
}

/**
 * Default display view: hides superseded parts and drops assistant messages that
 * have no visible parts left. The raw state keeps the diagnostic records.
 */
export function selectVisibleSessionMessagesWithParts(
  bucket: SessionBucket | undefined,
): SessionMessageWithParts[] {
  return selectSessionMessagesWithParts(bucket)
    .map(({ message, parts }) => ({
      message,
      parts: parts.filter((part) => !isSupersededModelPart(part)),
    }))
    .filter(({ message, parts }) =>
      parts.length > 0 || message.role !== "assistant",
    );
}

export function selectSessionInputs(bucket: SessionBucket | undefined) {
  if (!bucket) return [];
  return [...bucket.inputs].sort((a, b) => a.seq - b.seq);
}

export function selectSessionOrderedMessages(bucket: SessionBucket | undefined) {
  if (!bucket) return [];
  return [...bucket.messages].sort((a, b) => a.seq - b.seq);
}

export function selectSessionParts(bucket: SessionBucket | undefined) {
  if (!bucket) return [];
  return Object.values(bucket.partsByMessageId)
    .flat()
    .sort((a, b) => a.seq - b.seq);
}

export function selectSessionRuns(bucket: SessionBucket | undefined) {
  if (!bucket) return [];
  return Object.values(bucket.runs);
}

/** Current bounded-retry wait, if the latest active run is waiting. */
export function selectSessionModelRetry(
  bucket: SessionBucket | undefined,
): SessionModelRetryState | undefined {
  if (!bucket) return undefined;
  const active = Object.values(bucket.runs)
    .filter((run) => run.status === "running" || run.status === "pending")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const run of active) {
    const state = readSessionModelRetryState(run.metadata);
    if (state) return state;
  }
  return undefined;
}

/** Aggregated usage completeness for the most recently updated run. */
export function selectSessionModelUsage(
  bucket: SessionBucket | undefined,
): SessionModelUsageSummary | undefined {
  if (!bucket) return undefined;
  const runs = Object.values(bucket.runs).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const run of runs) {
    const usage = readSessionModelUsage(run.metadata);
    if (usage) return usage;
  }
  return undefined;
}

export function selectSessionTasks(bucket: SessionBucket | undefined) {
  if (!bucket) return [];
  return Object.values(bucket.tasks);
}

export function selectSessionPermissions(bucket: SessionBucket | undefined) {
  if (!bucket) return [];
  return Object.values(bucket.permissions);
}

export function selectFirstPendingPermission(
  state: import("../types/index.js").VykorClientState,
  sessionId?: string,
): import("../types/index.js").PermissionRequestRecord | undefined {
  if (!sessionId) return undefined;
  const bucket = state.buckets[sessionId];
  if (!bucket) return undefined;
  return Object.values(bucket.permissions)
    .filter((request) => request.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt)
    .at(0);
}

