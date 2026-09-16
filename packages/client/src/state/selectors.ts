/**
 * Read-only selectors over the reducer state.
 *
 * These stay UI-agnostic so TUI/Web/Desktop can share the canonical
 * message/part view and map it to their own presentation models.
 */

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

export function selectSessionTasks(bucket: SessionBucket | undefined) {
  if (!bucket) return [];
  return Object.values(bucket.tasks);
}

export function selectSessionPermissions(bucket: SessionBucket | undefined) {
  if (!bucket) return [];
  return Object.values(bucket.permissions);
}

export function selectFirstPendingPermission(
  state: import("../types/index.js").OpenHarnessClientState,
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

