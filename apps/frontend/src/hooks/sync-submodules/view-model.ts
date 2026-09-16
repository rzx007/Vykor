import {
  patchSessionRuntimeMetadata,
  type SessionRuntimeConfigPatch,
  type OpenHarnessClientState,
  type SessionBucket,
  type SessionRecord,
  type SyncEventUpdate,
} from "@openharness/client";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function sessionRuntimeMetadata(input: {
  model?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
  apiFormat?: unknown;
  permissionMode?: unknown;
  maxTurns?: unknown;
  sessionMode?: unknown;
  pluginsEnabled?: unknown;
}): Record<string, unknown> {
  const runtime: SessionRuntimeConfigPatch = {};
  if (typeof input.model === "string" && input.model) {
    runtime.model = input.model;
  }
  if (typeof input.provider === "string" && input.provider) {
    runtime.provider = input.provider;
  }
  if (typeof input.baseUrl === "string" && input.baseUrl) {
    runtime.baseUrl = input.baseUrl;
  }
  if (input.apiFormat === "anthropic" || input.apiFormat === "openai") {
    runtime.apiFormat = input.apiFormat;
  }
  if (input.permissionMode === "default" || input.permissionMode === "plan" || input.permissionMode === "full_auto") {
    runtime.permissionMode = input.permissionMode;
  }
  if (typeof input.maxTurns === "number" && Number.isFinite(input.maxTurns)) {
    runtime.maxTurns = input.maxTurns;
  }
  if (input.sessionMode === "coordinator" || input.sessionMode === "direct") {
    runtime.sessionMode = input.sessionMode;
  }
  if (typeof input.pluginsEnabled === "boolean") {
    runtime.pluginsEnabled = input.pluginsEnabled;
  }
  return patchSessionRuntimeMetadata({}, runtime);
}

export function archiveClientSession(
  state: OpenHarnessClientState,
  sessionId: string,
  archivedAt: number
): OpenHarnessClientState {
  const current = state.sessions[sessionId];
  if (!current || current.status === "archived") return state;
  const archived: SessionRecord = {
    ...current,
    status: "archived",
    archivedAt,
    updatedAt: Math.max(current.updatedAt, archivedAt),
  };
  const bucket = state.buckets[sessionId];
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: archived },
    buckets: bucket
      ? { ...state.buckets, [sessionId]: { ...bucket, session: archived } }
      : state.buckets,
  };
}

export function listTopLevelSessions(
  sessions: Iterable<SessionRecord>,
  activeSessionId?: string
): SessionRecord[] {
  return [...sessions]
    .filter((session) => !session.parentId && session.status !== "archived")
    .sort((a, b) => {
      if (a.id === activeSessionId) return -1;
      if (b.id === activeSessionId) return 1;
      return b.updatedAt - a.updatedAt;
    });
}

export function sessionSelectOptions(
  sessions: Iterable<SessionRecord>,
  activeSessionId?: string
): Array<{ value: string; label: string; description: string }> {
  return listTopLevelSessions(sessions, activeSessionId).map((session) => ({
    value: session.id,
    label: `${session.id === activeSessionId ? "* " : ""}${session.title || session.id}`,
    description: `${session.model} | ${session.status}`,
  }));
}

export type RecoverableRun = {
  id: string;
  error?: string;
  prompt: string;
};

export function recoverableInterruptedRuns(bucket?: SessionBucket): RecoverableRun[] {
  if (!bucket) return [];
  const recoveredSourceRunIds = new Set(
    bucket.inputs.flatMap((input) =>
      isRecord(input.metadata.recovery) && typeof input.metadata.recovery.sourceRunId === "string"
        ? [input.metadata.recovery.sourceRunId]
        : [],
    ),
  );
  return Object.values(bucket.runs)
    .filter((run) => run.status === "interrupted" && !!run.inputId && !recoveredSourceRunIds.has(run.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .flatMap((run) => {
      const input = bucket.inputs.find((candidate) => candidate.id === run.inputId);
      return input ? [{ id: run.id, error: run.error, prompt: input.content }] : [];
    });
}

export function shouldCoalesceClientState(update: SyncEventUpdate): boolean {
  return update.source === "live" && update.event?.type === "session.message.part.delta";
}
