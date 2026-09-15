import type {
  PermissionRequestRecord,
  AttachmentLimits,
  SessionEventRecord,
  SessionInputAttachmentRecord,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionRunAttemptRecord,
  SessionExecutionRecord,
} from "@openharness/protocol";
import type { TransactionCoordinatorHooks } from "../database/index.js";
import type { DurableEventRegistry } from "./event-registry.js";

export interface SessionState {
  nextEventSeq: number;
  sessions: Record<string, SessionRecord>;
  inputs: Record<string, SessionInputRecord>;
  inputAttachments: Record<string, SessionInputAttachmentRecord>;
  messages: Record<string, SessionMessageRecord>;
  parts: Record<string, SessionMessagePartRecord>;
  events: SessionEventRecord[];
  runs: Record<string, SessionRunRecord>;
  attempts: Record<string, SessionRunAttemptRecord>;
  tasks: Record<string, SessionExecutionRecord>;
  permissions: Record<string, PermissionRequestRecord>;
}

export interface SessionStoreOptions {
  path: string;
  deltaFlushIntervalMs?: number;
  deltaFlushBytes?: number;
  /** Dedicated extension point for tests or plugins that own additional event contracts. */
  eventRegistry?: DurableEventRegistry;
  attachmentLimits?: Partial<AttachmentLimits>;
  transactionHooks?: TransactionCoordinatorHooks;
}

export const DEFAULT_DELTA_FLUSH_INTERVAL_MS = 150;
export const DEFAULT_DELTA_FLUSH_BYTES = 8 * 1024;

export function now(): number {
  return Date.now();
}

export function emptyState(): SessionState {
  return {
    nextEventSeq: 1,
    sessions: {},
    inputs: {},
    inputAttachments: {},
    messages: {},
    parts: {},
    events: [],
    runs: {},
    attempts: {},
    tasks: {},
    permissions: {},
  };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function encode(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function decode(value: string | null): Record<string, unknown> {
  return value ? (JSON.parse(value) as Record<string, unknown>) : {};
}

export function isDurableEvent(event: SessionEventRecord): boolean {
  return event.type !== "session.message.part.delta";
}

export function isTerminalRunStatus(
  status: SessionRunRecord["status"],
): boolean {
  return (
    status === "completed" || status === "failed" || status === "interrupted"
  );
}

export function isTerminalAttemptStatus(
  status: SessionRunAttemptRecord["status"],
): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function maxSeq<T extends { sessionId: string; seq: number }>(
  table: Record<string, T>,
  sessionId: string,
): number {
  let seq = 0;
  for (const row of Object.values(table)) {
    if (row.sessionId === sessionId && row.seq > seq) seq = row.seq;
  }
  return seq;
}

export function assertSession(
  state: SessionState,
  sessionId: string,
): SessionRecord {
  const session = state.sessions[sessionId];
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session;
}

export function assertMutableSession(session: SessionRecord): void {
  if (session.status === "archived") {
    throw new Error(`Session is archived: ${session.id}`);
  }
  if (session.status === "closing") {
    throw new Error(`Session is closing: ${session.id}`);
  }
}

export function assertMessage(
  state: SessionState,
  messageId: string,
): SessionMessageRecord {
  const message = state.messages[messageId];
  if (!message) throw new Error(`Session message not found: ${messageId}`);
  return message;
}
