/**
 * 事件 → 客户端状态 reducer。
 *
 * 幂等：同一 `seq` 只应用一次。多端用同一套事件流应收敛到相同状态。
 */

import { sessionEventSchemaVersion } from "@openharness/protocol";

import type {
  OpenHarnessClientState,
  PermissionRequestRecord,
  SessionBucket,
  SessionEventRecord,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
  SessionRunRecord,
  SessionRunAttemptRecord,
  SessionExecutionRecord,
  SessionStateSnapshot,
} from "../types/index.js";

export class UnsupportedSessionEventSchemaVersionError extends Error {
  readonly event: Pick<SessionEventRecord, "seq" | "type" | "schemaVersion">;

  constructor(event: SessionEventRecord) {
    const expected = sessionEventSchemaVersion(event.type);
    super(
      `Unsupported session event schema version ${event.schemaVersion} for ${event.type} at sequence ${event.seq}; expected ${expected}`,
    );
    this.name = "UnsupportedSessionEventSchemaVersionError";
    this.event = {
      seq: event.seq,
      type: event.type,
      schemaVersion: event.schemaVersion,
    };
  }
}

/** 空客户端状态，作为 replay/hydrate 起点。 */
export function createInitialClientState(): OpenHarnessClientState {
  return {
    sessions: {},
    sessionOrder: [],
    buckets: {},
    eventsBySeq: {},
    snapshotCursorBySession: {},
    transientCursor: 0,
    lastSeq: 0,
  };
}

/** 按序批量应用事件。 */
export function applyEvents(
  state: OpenHarnessClientState,
  events: Iterable<SessionEventRecord>,
): OpenHarnessClientState {
  let next = state;
  for (const event of events) next = applyEvent(next, event);
  return next;
}

/** Replace one session bucket with an atomic server snapshot. */
export function applySessionSnapshot(
  state: OpenHarnessClientState,
  snapshot: SessionStateSnapshot,
): OpenHarnessClientState {
  const knownCursor = state.snapshotCursorBySession[snapshot.session.id] ?? 0;
  if (snapshot.cursor < knownCursor) return state;

  const partsByMessageId: SessionBucket["partsByMessageId"] = {};
  for (const part of snapshot.parts) {
    const parts = partsByMessageId[part.messageId] ?? [];
    parts.push(part);
    partsByMessageId[part.messageId] = parts;
  }
  for (const parts of Object.values(partsByMessageId)) parts.sort((a, b) => a.seq - b.seq);

  const sessions = { ...state.sessions, [snapshot.session.id]: snapshot.session };
  return {
    ...state,
    sessions,
    sessionOrder: sortSessionOrder(sessions),
    buckets: {
      ...state.buckets,
      [snapshot.session.id]: {
        session: snapshot.session,
        inputs: [...snapshot.inputs].sort((a, b) => a.seq - b.seq),
        messages: [...snapshot.messages].sort((a, b) => a.seq - b.seq),
        partsByMessageId,
        runs: Object.fromEntries(snapshot.runs.map((run) => [run.id, run])),
        attempts: Object.fromEntries((snapshot.attempts ?? []).map((attempt) => [attempt.id, attempt])),
        tasks: Object.fromEntries((snapshot.tasks ?? []).map((task) => [task.id, task])),
        permissions: Object.fromEntries(snapshot.permissions.map((request) => [request.id, request])),
      },
    },
    snapshotCursorBySession: {
      ...state.snapshotCursorBySession,
      [snapshot.session.id]: Math.max(
        state.snapshotCursorBySession[snapshot.session.id] ?? 0,
        snapshot.cursor,
      ),
    },
    transientCursor: Math.max(state.transientCursor, snapshot.cursor),
    lastSeq: Math.max(state.lastSeq, snapshot.cursor),
  };
}

/**
 * 应用单条事件。已见过的 `seq` 直接返回原 state（引用相等，便于 live 去重）。
 */
export function applyEvent(
  state: OpenHarnessClientState,
  event: SessionEventRecord,
): OpenHarnessClientState {
  if (event.schemaVersion !== sessionEventSchemaVersion(event.type)) {
    throw new UnsupportedSessionEventSchemaVersionError(event);
  }
  const transient = event.type === "session.message.part.delta";
  const snapshotCursor = event.sessionId
    ? state.snapshotCursorBySession[event.sessionId] ?? 0
    : 0;
  if (event.seq <= snapshotCursor) return state;
  if (transient && event.seq <= state.transientCursor) return state;
  if (!transient && state.eventsBySeq[event.seq]) return state;
  if (!transient) state.eventsBySeq[event.seq] = event;

  let next: OpenHarnessClientState = {
    ...state,
    eventsBySeq: state.eventsBySeq,
    transientCursor: transient ? event.seq : state.transientCursor,
    lastSeq: Math.max(state.lastSeq, event.seq),
  };

  switch (event.type) {
    case "session.created":
    case "session.updated":
      next = upsertSession(next, readPayloadRecord<SessionRecord>(event, "session"));
      break;
    case "session.archived":
      next = archiveSession(next, event);
      break;
    case "session.deleted":
      next = deleteSessions(next, event);
      break;
    case "session.input.admitted":
      next = upsertInput(next, readPayloadRecord<SessionInputRecord>(event, "input"));
      break;
    case "session.message.created":
      next = upsertMessage(next, readPayloadRecord<SessionMessageRecord>(event, "message"));
      break;
    case "session.transcript.replaced":
      next = replaceTranscript(next, event);
      break;
    case "session.message.part.updated":
      next = upsertPart(next, readPayloadRecord<SessionMessagePartRecord>(event, "part"));
      break;
    case "session.message.part.delta":
      next = appendPartDelta(next, event);
      break;
    case "session.run.created":
    case "session.run.updated":
      next = upsertRun(next, readPayloadRecord<SessionRunRecord>(event, "run"));
      break;
    case "session.run_attempt.created":
    case "session.run_attempt.updated":
      next = upsertRunAttempt(next, readPayloadRecord<SessionRunAttemptRecord>(event, "attempt"));
      break;
    case "session.task.created":
    case "session.task.updated":
      next = upsertTask(next, readPayloadRecord<SessionExecutionRecord>(event, "task"));
      break;
    case "permission.asked":
    case "permission.replied":
      next = upsertPermission(next, readPayloadRecord<PermissionRequestRecord>(event, "request"));
      break;
  }

  return next;
}

function readPayloadRecord<T>(event: SessionEventRecord, key: string): T | undefined {
  const value = event.payload[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as T : undefined;
}

function upsertSession(state: OpenHarnessClientState, session: SessionRecord | undefined): OpenHarnessClientState {
  if (!session) return state;
  const bucket = cloneBucket(state.buckets[session.id]);
  bucket.session = session;
  const sessions = { ...state.sessions, [session.id]: session };
  return {
    ...state,
    sessions,
    sessionOrder: sortSessionOrder(sessions),
    buckets: { ...state.buckets, [session.id]: bucket },
  };
}

function archiveSession(state: OpenHarnessClientState, event: SessionEventRecord): OpenHarnessClientState {
  const sessionId = typeof event.payload.sessionId === "string" ? event.payload.sessionId : event.sessionId;
  if (!sessionId) return state;
  const current = state.sessions[sessionId];
  if (!current) return state;
  const archived: SessionRecord = {
    ...current,
    status: "archived",
    archivedAt: current.archivedAt ?? event.createdAt,
    updatedAt: Math.max(current.updatedAt, event.createdAt),
  };
  return upsertSession(state, archived);
}

function deleteSessions(state: OpenHarnessClientState, event: SessionEventRecord): OpenHarnessClientState {
  const ids = new Set(Array.isArray(event.payload.sessionIds)
    ? event.payload.sessionIds.filter((id): id is string => typeof id === "string") : []);
  if (ids.size === 0) return state;
  return {
    ...state,
    sessions: Object.fromEntries(Object.entries(state.sessions).filter(([id]) => !ids.has(id))),
    sessionOrder: state.sessionOrder.filter((id) => !ids.has(id)),
    buckets: Object.fromEntries(Object.entries(state.buckets).filter(([id]) => !ids.has(id))),
    snapshotCursorBySession: Object.fromEntries(Object.entries(state.snapshotCursorBySession).filter(([id]) => !ids.has(id))),
    eventsBySeq: Object.fromEntries(Object.entries(state.eventsBySeq).filter(([, item]) => !item.sessionId || !ids.has(item.sessionId))),
  };
}

function upsertInput(state: OpenHarnessClientState, input: SessionInputRecord | undefined): OpenHarnessClientState {
  if (!input) return state;
  const bucket = cloneBucket(state.buckets[input.sessionId]);
  bucket.inputs = upsertSorted(bucket.inputs, input, (row) => row.seq);
  return { ...state, buckets: { ...state.buckets, [input.sessionId]: bucket } };
}

function upsertMessage(state: OpenHarnessClientState, message: SessionMessageRecord | undefined): OpenHarnessClientState {
  if (!message) return state;
  const bucket = cloneBucket(state.buckets[message.sessionId]);
  bucket.messages = upsertSorted(bucket.messages, message, (row) => row.seq);
  return { ...state, buckets: { ...state.buckets, [message.sessionId]: bucket } };
}

function replaceTranscript(state: OpenHarnessClientState, event: SessionEventRecord): OpenHarnessClientState {
  const sessionId = event.sessionId;
  if (!sessionId) return state;
  const messages = Array.isArray(event.payload.messages)
    ? event.payload.messages.filter((row): row is SessionMessageRecord =>
      !!row && typeof row === "object" && !Array.isArray(row) && typeof (row as SessionMessageRecord).id === "string")
    : [];
  const parts = Array.isArray(event.payload.parts)
    ? event.payload.parts.filter((row): row is SessionMessagePartRecord =>
      !!row && typeof row === "object" && !Array.isArray(row) && typeof (row as SessionMessagePartRecord).id === "string")
    : [];
  const bucket = cloneBucket(state.buckets[sessionId]);
  const partsByMessageId: SessionBucket["partsByMessageId"] = {};
  for (const part of parts) {
    const rows = partsByMessageId[part.messageId] ?? [];
    rows.push(part);
    partsByMessageId[part.messageId] = rows;
  }
  for (const rows of Object.values(partsByMessageId)) rows.sort((a, b) => a.seq - b.seq);
  bucket.messages = [...messages].sort((a, b) => a.seq - b.seq);
  bucket.partsByMessageId = partsByMessageId;
  if (bucket.session) {
    bucket.session = {
      ...bucket.session,
      updatedAt: Math.max(bucket.session.updatedAt, event.createdAt),
    };
  }
  const sessions = bucket.session
    ? { ...state.sessions, [sessionId]: bucket.session }
    : state.sessions;
  return {
    ...state,
    sessions,
    sessionOrder: sortSessionOrder(sessions),
    buckets: { ...state.buckets, [sessionId]: bucket },
  };
}

function upsertPart(state: OpenHarnessClientState, part: SessionMessagePartRecord | undefined): OpenHarnessClientState {
  if (!part) return state;
  const bucket = cloneBucketForPartWrite(state.buckets[part.sessionId]);
  const existing = bucket.partsByMessageId[part.messageId] ?? [];
  bucket.partsByMessageId = {
    ...bucket.partsByMessageId,
    [part.messageId]: upsertSorted(existing, part, (row) => row.seq),
  };
  return { ...state, buckets: { ...state.buckets, [part.sessionId]: bucket } };
}

function appendPartDelta(state: OpenHarnessClientState, event: SessionEventRecord): OpenHarnessClientState {
  const sessionId = typeof event.payload.sessionId === "string" ? event.payload.sessionId : event.sessionId;
  const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : undefined;
  const partId = typeof event.payload.partId === "string" ? event.payload.partId : undefined;
  const field = event.payload.field;
  const delta = typeof event.payload.delta === "string" ? event.payload.delta : undefined;
  if (!sessionId || !messageId || !partId || field !== "text" || delta === undefined) return state;

  const bucket = cloneBucketForPartWrite(state.buckets[sessionId]);
  const currentParts = bucket.partsByMessageId[messageId] ?? [];
  const index = currentParts.findIndex((part) => part.id === partId);
  const nextParts = [...currentParts];
  if (index >= 0) {
    const current = nextParts[index]!;
    nextParts[index] = {
      ...current,
      text: `${current.text ?? ""}${delta}`,
      updatedAt: Math.max(current.updatedAt, event.createdAt),
    };
  } else {
    const seq = currentParts.reduce((max, part) => Math.max(max, part.seq), 0) + 1;
    nextParts.push({
      id: partId,
      sessionId,
      messageId,
      seq,
      type: "text",
      status: "running",
      text: delta,
      metadata: {},
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
    });
  }
  const sortedParts = index >= 0
    ? nextParts
    : nextParts.sort((a, b) => a.seq - b.seq);
  bucket.partsByMessageId = {
    ...bucket.partsByMessageId,
    [messageId]: sortedParts,
  };
  return { ...state, buckets: { ...state.buckets, [sessionId]: bucket } };
}

function upsertRun(state: OpenHarnessClientState, run: SessionRunRecord | undefined): OpenHarnessClientState {
  if (!run) return state;
  const bucket = cloneBucket(state.buckets[run.sessionId]);
  bucket.runs = { ...bucket.runs, [run.id]: run };
  const session = refreshSessionStatusFromRuns(bucket.session, bucket.runs, run.updatedAt);
  bucket.session = session;
  const sessions = session ? { ...state.sessions, [run.sessionId]: session } : state.sessions;
  return {
    ...state,
    sessions,
    sessionOrder: session ? sortSessionOrder(sessions) : state.sessionOrder,
    buckets: { ...state.buckets, [run.sessionId]: bucket },
  };
}

function upsertRunAttempt(
  state: OpenHarnessClientState,
  attempt: SessionRunAttemptRecord | undefined,
): OpenHarnessClientState {
  if (!attempt) return state;
  const run = Object.values(state.buckets)
    .flatMap((bucket) => Object.values(bucket.runs))
    .find((candidate) => candidate.id === attempt.runId);
  if (!run) return state;
  const bucket = cloneBucket(state.buckets[run.sessionId]);
  bucket.attempts = { ...bucket.attempts, [attempt.id]: attempt };
  return { ...state, buckets: { ...state.buckets, [run.sessionId]: bucket } };
}

function refreshSessionStatusFromRuns(
  session: SessionRecord | undefined,
  runs: SessionBucket["runs"],
  updatedAt: number,
): SessionRecord | undefined {
  if (!session || session.status === "archived" || session.status === "closing") return session;
  const running = Object.values(runs).some(
    (candidate) => candidate.status === "pending" || candidate.status === "running",
  );
  return {
    ...session,
    status: running ? "running" : "idle",
    updatedAt: Math.max(session.updatedAt, updatedAt),
  };
}

function upsertPermission(
  state: OpenHarnessClientState,
  request: PermissionRequestRecord | undefined,
): OpenHarnessClientState {
  if (!request) return state;
  const bucket = cloneBucket(state.buckets[request.sessionId]);
  bucket.permissions = { ...bucket.permissions, [request.id]: request };
  return { ...state, buckets: { ...state.buckets, [request.sessionId]: bucket } };
}

function upsertTask(state: OpenHarnessClientState, task: SessionExecutionRecord | undefined): OpenHarnessClientState {
  if (!task) return state;
  const bucket = cloneBucket(state.buckets[task.sessionId]);
  bucket.tasks = { ...bucket.tasks, [task.id]: task };
  return { ...state, buckets: { ...state.buckets, [task.sessionId]: bucket } };
}

function cloneBucket(bucket: SessionBucket | undefined): SessionBucket {
  return {
    session: bucket?.session,
    inputs: bucket?.inputs ? [...bucket.inputs] : [],
    messages: bucket?.messages ? [...bucket.messages] : [],
    partsByMessageId: bucket?.partsByMessageId
      ? Object.fromEntries(Object.entries(bucket.partsByMessageId).map(([id, parts]) => [id, [...parts]]))
      : {},
    runs: bucket?.runs ? { ...bucket.runs } : {},
    attempts: bucket?.attempts ? { ...bucket.attempts } : {},
    tasks: bucket?.tasks ? { ...bucket.tasks } : {},
    permissions: bucket?.permissions ? { ...bucket.permissions } : {},
  };
}

function cloneBucketForPartWrite(bucket: SessionBucket | undefined): SessionBucket {
  return {
    session: bucket?.session,
    inputs: bucket?.inputs ?? [],
    messages: bucket?.messages ?? [],
    partsByMessageId: bucket?.partsByMessageId ?? {},
    runs: bucket?.runs ?? {},
    attempts: bucket?.attempts ?? {},
    tasks: bucket?.tasks ?? {},
    permissions: bucket?.permissions ?? {},
  };
}

/** 按 id 覆盖后按 sortKey 升序排列。 */
function upsertSorted<T extends { id: string }>(rows: T[], row: T, sortKey: (row: T) => number): T[] {
  const without = rows.filter((existing) => existing.id !== row.id);
  without.push(row);
  return without.sort((a, b) => sortKey(a) - sortKey(b));
}

/** session 列表排序：最近更新优先。 */
function sortSessionOrder(sessions: Record<string, SessionRecord>): string[] {
  return Object.values(sessions)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .map((session) => session.id);
}
