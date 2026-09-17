import {
  defaultDurableEventRegistry,
  type SessionStore,
} from "@openharness/services";
import type {
  PermissionRequestRecord,
  ProjectionSettlementRecord,
  SessionEventRecord,
  SessionInputRecord,
  SessionMessagePartRecord,
} from "@openharness/protocol";

export interface RunInspectionWarning {
  code: "orphan_input" | "active_attempt_on_closed_run" | "unknown_event" | "pending_settlement" | "unknown_tool_outcome";
  message: string;
}

export type RunInspectorStore = Pick<SessionStore,
  "getRun" | "getInput" | "listRunAttempts" | "listMessages" |
  "listMessageParts" | "listSessionTasks" | "listEvents" | "listProjectionSettlements"
>;

export interface RunInspection {
  runId: string;
  includeContent: boolean;
  sensitiveContentWarning?: string;
  run: NonNullable<ReturnType<RunInspectorStore["getRun"]>>;
  input?: SessionInputRecord;
  sourceRecovery?: Record<string, unknown>;
  attempts: ReturnType<RunInspectorStore["listRunAttempts"]>;
  messages: ReturnType<RunInspectorStore["listMessages"]>;
  parts: SessionMessagePartRecord[];
  toolCalls: SessionMessagePartRecord[];
  permissions: PermissionRequestRecord[];
  childExecutions: ReturnType<RunInspectorStore["listSessionTasks"]>;
  workflows: Array<{
    runId: string;
    status: string;
    ownerSessionId?: string;
    ownerInputId?: string;
    ownerRunId?: string;
    snapshot?: Record<string, unknown>;
  }>;
  traceIds: string[];
  events: SessionEventRecord[];
  projectionSettlements: ProjectionSettlementRecord[];
  warnings: RunInspectionWarning[];
  diagnosticOk: boolean;
}

export function inspectDurableRun(
  store: RunInspectorStore,
  permissions: Pick<SessionStore["permissions"], "list">,
  workflowQueries: Pick<SessionStore["workflows"], "listRuns">,
  runId: string,
  includeContent = false,
): RunInspection | undefined {
  const run = store.getRun(runId);
  if (!run) return undefined;
  const input = run.inputId ? store.getInput(run.inputId) : undefined;
  const messages = store.listMessages(run.sessionId).filter((row) => row.runId === runId || row.inputId === run.inputId);
  const messageIds = new Set(messages.map((row) => row.id));
  const parts = store.listMessageParts(run.sessionId).filter((row) => messageIds.has(row.messageId));
  const permissionRequests = permissions.list({ sessionId: run.sessionId }).filter((row) => row.runId === runId);
  const childExecutions = store.listSessionTasks(run.sessionId).filter((row) => row.runId === runId || row.metadata.sourceRunId === runId);
  const attempts = store.listRunAttempts(runId);
  const workflows = workflowQueries
    .listRuns()
    .filter((workflow) => workflow.ownerRunId === runId);
  const references = new Set<string>([
    runId,
    ...(run.inputId ? [run.inputId] : []),
    ...attempts.map((row) => row.id),
    ...messages.map((row) => row.id),
    ...parts.flatMap((row) => [row.id, row.toolUseId, stringMetadata(row.metadata.toolAttemptId)]).filter((value): value is string => !!value),
    ...permissionRequests.map((row) => row.id),
    ...childExecutions.flatMap((row) => [row.id, row.childSessionId]).filter((value): value is string => !!value),
    ...workflows.map((workflow) => workflow.runId),
  ]);
  const events = store.listEvents({ sessionId: run.sessionId }).filter((event) => containsReference(event.payload, references));
  const projectionSettlements = store.listProjectionSettlements().filter((row) =>
    row.rootSessionId === run.sessionId && (containsReference(row.payload, references) || row.status === "pending" || row.status === "retrying"));
  const warnings: RunInspectionWarning[] = [];
  if (run.inputId && !input) warnings.push({ code: "orphan_input", message: `Run points to missing input ${run.inputId}` });
  if (run.status !== "pending" && run.status !== "running" && store.listRunAttempts(runId).some((row) => row.status === "pending" || row.status === "running")) {
    warnings.push({ code: "active_attempt_on_closed_run", message: "Run is closed but at least one model attempt is still active" });
  }
  for (const event of events) {
    try {
      defaultDurableEventRegistry.prepareRead(event.type, event.schemaVersion, event.payload, event.sessionId);
    } catch {
      warnings.push({ code: "unknown_event", message: `Event ${event.id} (${event.type}) cannot be read by the current event registry` });
    }
  }
  for (const row of projectionSettlements.filter((item) => item.status === "pending" || item.status === "retrying")) {
    warnings.push({ code: "pending_settlement", message: `Projection settlement ${row.id} is ${row.status}` });
  }
  for (const part of parts.filter((row) => row.type === "tool" && row.metadata.failureKind === "unknown_outcome")) {
    warnings.push({ code: "unknown_tool_outcome", message: `Tool call ${part.toolUseId ?? part.id} may have executed; automatic retry is unsafe` });
  }
  const traceIds = uniqueStrings([
    run.metadata.traceId,
    input?.metadata.traceId,
    ...messages.map((row) => row.metadata.traceId),
    ...events.map((row) => row.payload.traceId),
  ]);
  const sourceRecovery = pickRecovery(run.metadata);
  return {
    runId,
    includeContent,
    ...(includeContent ? { sensitiveContentWarning: "Content view may contain prompts, model output, tool arguments, tool results, or secrets." } : {}),
    run: includeContent ? run : { ...run, error: run.error ? "[redacted]" : undefined, metadata: redactRecord(run.metadata) },
    ...(input ? { input: includeContent ? input : { ...input, items: [], content: "[redacted]", metadata: redactRecord(input.metadata) } } : {}),
    ...(sourceRecovery ? { sourceRecovery } : {}),
    attempts: attempts.map((row) => includeContent ? row : { ...row, error: row.error ? "[redacted]" : undefined }),
    messages: messages.map((row) => ({ ...row, metadata: includeContent ? row.metadata : redactRecord(row.metadata) })),
    parts: parts.map((row) => redactPart(row, includeContent)),
    toolCalls: parts.filter((row) => row.type === "tool" || row.type === "tool_result").map((row) => redactPart(row, includeContent)),
    permissions: permissionRequests.map((row) => includeContent ? row : { ...row, payload: { redacted: true } }),
    childExecutions: childExecutions.map((row) => includeContent ? row : {
      ...row,
      description: "[redacted]",
      output: row.output ? "[redacted]" : undefined,
      error: row.error ? "[redacted]" : undefined,
      metadata: redactRecord(row.metadata),
    }),
    workflows: workflows.map((workflow) => ({
      runId: workflow.runId,
      status: workflow.status,
      ownerSessionId: workflow.ownerSessionId,
      ownerInputId: workflow.ownerInputId,
      ownerRunId: workflow.ownerRunId,
      ...(includeContent
        ? { snapshot: JSON.parse(workflow.snapshotJson) as Record<string, unknown> }
        : {}),
    })),
    traceIds,
    events: events.map((row) => includeContent ? row : { ...row, payload: redactRecord(row.payload) }),
    projectionSettlements: projectionSettlements.map((row) => includeContent ? row : { ...row, payload: { redacted: true } }),
    warnings,
    diagnosticOk: warnings.length === 0,
  };
}

export function listProjectionDiagnostics(store: RunInspectorStore, includeContent = false): {
  includeContent: boolean;
  sensitiveContentWarning?: string;
  settlements: ProjectionSettlementRecord[];
  pending: number;
  diagnosticOk: boolean;
} {
  const rows = store.listProjectionSettlements();
  const pending = rows.filter((row) => row.status === "pending" || row.status === "retrying").length;
  return {
    includeContent,
    ...(includeContent ? { sensitiveContentWarning: "Settlement payloads may contain runtime content or identifiers." } : {}),
    settlements: rows.map((row) => includeContent ? row : { ...row, payload: { redacted: true } }),
    pending,
    diagnosticOk: pending === 0,
  };
}

function containsReference(value: unknown, references: ReadonlySet<string>): boolean {
  if (typeof value === "string" && references.has(value)) return true;
  if (Array.isArray(value)) return value.some((item) => containsReference(item, references));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((item) => containsReference(item, references));
}

function redactPart(part: SessionMessagePartRecord, includeContent: boolean): SessionMessagePartRecord {
  if (includeContent) return part;
  return {
    ...part,
    text: part.text === undefined ? undefined : "[redacted]",
    input: part.input === undefined ? undefined : { redacted: true },
    output: part.output === undefined ? undefined : "[redacted]",
    metadata: redactRecord(part.metadata),
  };
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  const visible = new Set(["traceId", "sourceRunId", "sourceInputId", "recoveryRunId", "recoveryInputId", "toolCallId", "toolAttemptId", "outcome", "failureKind", "warning"]);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visible.has(key) ? item : "[redacted]"]));
}

function pickRecovery(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const result = Object.fromEntries(Object.entries(metadata).filter(([key]) => /source|recover|retry/i.test(key)));
  return Object.keys(result).length > 0 ? result : undefined;
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
