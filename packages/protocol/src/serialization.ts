import type {
  PermissionRequestRecord,
  SessionEventRecord,
  SessionExecutionRecord,
  SessionInputRecord,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRunAttemptRecord,
  SessionRunRecord,
  SessionStateSnapshot,
} from "./session.js";
import type { AttachmentIntent } from "./attachment.js";
import type { JobReadResult, JobSnapshot, JobWaitResult } from "./job.js";
import type {
  TerminalEvent,
  TerminalReadResult,
  TerminalSessionInfo,
  TerminalWaitResult,
} from "./terminal.js";
import type { ProtocolError } from "./requests.js";

export class ProtocolDataError extends Error {
  readonly code = "invalid_protocol_data";
  readonly details?: Record<string, unknown>;

  constructor(message: string, path?: string) {
    super(message);
    this.name = "ProtocolDataError";
    this.details = path ? { path } : undefined;
  }

  toProtocolError(): ProtocolError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

type DataRecord = Record<string, unknown>;
type Validator<T> = (value: unknown, path: string) => T;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolDataError("Protocol data must be valid JSON");
  }
}

function object(value: unknown, path: string): DataRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolDataError(`${path} must be an object`, path);
  }
  return value as DataRecord;
}

function stringField(value: DataRecord, field: string, path: string): string {
  const fieldPath = `${path}.${field}`;
  if (typeof value[field] !== "string") {
    throw new ProtocolDataError(`${fieldPath} must be a string`, fieldPath);
  }
  return value[field] as string;
}

function optionalString(value: DataRecord, field: string, path: string): void {
  const fieldValue = value[field];
  if (fieldValue !== undefined && typeof fieldValue !== "string") {
    const fieldPath = `${path}.${field}`;
    throw new ProtocolDataError(`${fieldPath} must be a string`, fieldPath);
  }
}

function numberField(value: DataRecord, field: string, path: string): number {
  const fieldPath = `${path}.${field}`;
  const fieldValue = value[field];
  if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
    throw new ProtocolDataError(`${fieldPath} must be a finite number`, fieldPath);
  }
  return fieldValue;
}

function optionalNumber(
  value: DataRecord,
  field: string,
  path: string,
  nullable = false,
): void {
  const fieldValue = value[field];
  if (fieldValue === undefined || (nullable && fieldValue === null)) return;
  if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
    const fieldPath = `${path}.${field}`;
    throw new ProtocolDataError(`${fieldPath} must be a finite number`, fieldPath);
  }
}

function booleanField(value: DataRecord, field: string, path: string): boolean {
  const fieldPath = `${path}.${field}`;
  if (typeof value[field] !== "boolean") {
    throw new ProtocolDataError(`${fieldPath} must be a boolean`, fieldPath);
  }
  return value[field] as boolean;
}

function recordField(value: DataRecord, field: string, path: string): DataRecord {
  return object(value[field], `${path}.${field}`);
}

function optionalRecord(value: DataRecord, field: string, path: string): void {
  if (value[field] !== undefined) object(value[field], `${path}.${field}`);
}

function enumField<const T extends readonly string[]>(
  value: DataRecord,
  field: string,
  path: string,
  allowed: T,
): T[number] {
  const fieldPath = `${path}.${field}`;
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || !allowed.includes(fieldValue)) {
    throw new ProtocolDataError(
      `${fieldPath} must be one of: ${allowed.join(", ")}`,
      fieldPath,
    );
  }
  return fieldValue as T[number];
}

function arrayField<T>(
  value: DataRecord,
  field: string,
  path: string,
  validate: Validator<T>,
): T[] {
  const fieldPath = `${path}.${field}`;
  const items = value[field];
  if (!Array.isArray(items)) {
    throw new ProtocolDataError(`${fieldPath} must be an array`, fieldPath);
  }
  return items.map((item, index) => validate(item, `${fieldPath}[${index}]`));
}

function validateSession(value: unknown, path: string) {
  const item = object(value, path);
  stringField(item, "id", path);
  stringField(item, "cwd", path);
  stringField(item, "title", path);
  stringField(item, "model", path);
  enumField(item, "status", path, ["idle", "running", "closing", "archived", "error"] as const);
  recordField(item, "metadata", path);
  numberField(item, "createdAt", path);
  numberField(item, "updatedAt", path);
  for (const field of ["parentId", "projectId", "cwdRelative", "agent"] as const) {
    optionalString(item, field, path);
  }
  optionalNumber(item, "archivedAt", path);
  return item;
}

function validateInput(value: unknown, path: string): SessionInputRecord {
  const item = object(value, path);
  stringField(item, "id", path);
  stringField(item, "sessionId", path);
  numberField(item, "seq", path);
  enumField(item, "delivery", path, ["queue", "steer"] as const);
  stringField(item, "content", path);
  const attachments = arrayField(item, "attachments", path, validateInputAttachment);
  const assetIds = new Set<string>();
  for (const [index, attachment] of attachments.entries()) {
    const attachmentPath = `${path}.attachments[${index}]`;
    if (attachment.sessionId !== item.sessionId) {
      throw new ProtocolDataError(
        `${attachmentPath}.sessionId must match ${path}.sessionId`,
        `${attachmentPath}.sessionId`,
      );
    }
    if (attachment.inputId !== item.id) {
      throw new ProtocolDataError(
        `${attachmentPath}.inputId must match ${path}.id`,
        `${attachmentPath}.inputId`,
      );
    }
    if (attachment.seq !== index) {
      throw new ProtocolDataError(
        `${attachmentPath}.seq must equal its array index`,
        `${attachmentPath}.seq`,
      );
    }
    if (assetIds.has(attachment.assetId)) {
      throw new ProtocolDataError(
        `${attachmentPath}.assetId must be unique within the input`,
        `${attachmentPath}.assetId`,
      );
    }
    assetIds.add(attachment.assetId);
  }
  optionalString(item, "promotedMessageId", path);
  recordField(item, "metadata", path);
  numberField(item, "createdAt", path);
  return item as unknown as SessionInputRecord;
}

function validateInputAttachment(value: unknown, path: string) {
  const item = object(value, path);
  for (const field of ["id", "sessionId", "inputId", "assetId", "displayName", "mediaType"] as const) {
    stringField(item, field, path);
  }
  numberField(item, "seq", path);
  enumField(item, "intent", path, [
    "auto",
    "vision",
    "ocr",
    "document",
    "tool_resource",
    "workspace_reference",
  ] as const satisfies readonly AttachmentIntent[]);
  numberField(item, "sizeBytes", path);
  recordField(item, "metadata", path);
  numberField(item, "createdAt", path);
  return item as unknown as SessionInputRecord["attachments"][number];
}

function validateMessage(value: unknown, path: string): SessionMessageRecord {
  const item = object(value, path);
  stringField(item, "id", path);
  stringField(item, "sessionId", path);
  numberField(item, "seq", path);
  enumField(item, "role", path, ["system", "user", "assistant"] as const);
  optionalString(item, "runId", path);
  optionalString(item, "inputId", path);
  recordField(item, "metadata", path);
  numberField(item, "createdAt", path);
  numberField(item, "updatedAt", path);
  return item as unknown as SessionMessageRecord;
}

function validatePart(value: unknown, path: string): SessionMessagePartRecord {
  const item = object(value, path);
  stringField(item, "id", path);
  stringField(item, "sessionId", path);
  stringField(item, "messageId", path);
  numberField(item, "seq", path);
  const type = enumField(item, "type", path, [
    "text",
    "attachment",
    "transformation",
    "reasoning",
    "tool",
    "tool_result",
    "error",
    "log",
  ] as const);
  enumField(item, "status", path, ["pending", "running", "completed", "failed", "interrupted"] as const);
  for (const field of ["text", "toolUseId", "toolName"] as const) optionalString(item, field, path);
  optionalRecord(item, "input", path);
  if (item.isError !== undefined && typeof item.isError !== "boolean") {
    throw new ProtocolDataError(`${path}.isError must be a boolean`, `${path}.isError`);
  }
  if (type === "attachment") {
    for (const field of ["assetId", "displayName", "mediaType"] as const) {
      stringField(item, field, path);
    }
    enumField(item, "intent", path, [
      "auto",
      "vision",
      "ocr",
      "document",
      "tool_resource",
      "workspace_reference",
    ] as const);
    numberField(item, "sizeBytes", path);
  }
  if (type === "transformation") {
    stringField(item, "assetId", path);
    enumField(item, "kind", path, ["direct", "document_extract", "tool_mount"] as const);
    for (const field of ["representationId", "processor", "transformationError"] as const) {
      optionalString(item, field, path);
    }
  }
  recordField(item, "metadata", path);
  numberField(item, "createdAt", path);
  numberField(item, "updatedAt", path);
  return item as unknown as SessionMessagePartRecord;
}

function validateRun(value: unknown, path: string): SessionRunRecord {
  const item = object(value, path);
  stringField(item, "id", path);
  stringField(item, "sessionId", path);
  optionalString(item, "inputId", path);
  enumField(item, "status", path, ["pending", "running", "completed", "failed", "interrupted"] as const);
  optionalNumber(item, "startedAt", path);
  optionalNumber(item, "finishedAt", path);
  optionalString(item, "error", path);
  recordField(item, "metadata", path);
  numberField(item, "createdAt", path);
  numberField(item, "updatedAt", path);
  return item as unknown as SessionRunRecord;
}

function validateAttempt(value: unknown, path: string): SessionRunAttemptRecord {
  const item = object(value, path);
  stringField(item, "id", path);
  stringField(item, "runId", path);
  numberField(item, "sequence", path);
  enumField(item, "status", path, ["pending", "running", "completed", "failed", "cancelled"] as const);
  for (const field of ["provider", "model", "retryReason", "errorKind", "error"] as const) {
    optionalString(item, field, path);
  }
  for (const field of ["inputTokens", "outputTokens", "startedAt", "finishedAt"] as const) {
    optionalNumber(item, field, path);
  }
  numberField(item, "createdAt", path);
  numberField(item, "updatedAt", path);
  return item as unknown as SessionRunAttemptRecord;
}

function validateTask(value: unknown, path: string): SessionExecutionRecord {
  const item = object(value, path);
  for (const field of ["id", "sessionId", "type", "description", "cwd"] as const) {
    stringField(item, field, path);
  }
  for (const field of ["childSessionId", "runId", "requestNamespace", "requestId", "output", "error"] as const) {
    optionalString(item, field, path);
  }
  enumField(item, "status", path, ["pending", "running", "completed", "failed", "stopped", "interrupted"] as const);
  recordField(item, "metadata", path);
  numberField(item, "createdAt", path);
  optionalNumber(item, "startedAt", path);
  optionalNumber(item, "finishedAt", path);
  numberField(item, "updatedAt", path);
  return item as unknown as SessionExecutionRecord;
}

function validatePermission(value: unknown, path: string): PermissionRequestRecord {
  const item = object(value, path);
  for (const field of ["id", "sessionId", "toolName"] as const) stringField(item, field, path);
  optionalString(item, "runId", path);
  recordField(item, "payload", path);
  enumField(item, "status", path, ["pending", "approved", "denied", "expired"] as const);
  optionalString(item, "decision", path);
  optionalString(item, "decidedByClientId", path);
  numberField(item, "createdAt", path);
  numberField(item, "updatedAt", path);
  return item as unknown as PermissionRequestRecord;
}

export function decodeSessionEventRecord(value: unknown): SessionEventRecord {
  const event = object(value, "event");
  stringField(event, "id", "event");
  numberField(event, "seq", "event");
  stringField(event, "type", "event");
  numberField(event, "schemaVersion", "event");
  optionalString(event, "sessionId", "event");
  recordField(event, "payload", "event");
  numberField(event, "createdAt", "event");
  return event as unknown as SessionEventRecord;
}

export function deserializeSessionEventRecord(text: string): SessionEventRecord {
  return decodeSessionEventRecord(parseJson(text));
}

export function serializeSessionEventRecord(event: SessionEventRecord): string {
  decodeSessionEventRecord(event);
  return JSON.stringify(event);
}

export function decodeSessionStateSnapshot(value: unknown): SessionStateSnapshot {
  const snapshot = object(value, "snapshot");
  numberField(snapshot, "cursor", "snapshot");
  validateSession(snapshot.session, "snapshot.session");
  arrayField(snapshot, "inputs", "snapshot", validateInput);
  arrayField(snapshot, "messages", "snapshot", validateMessage);
  arrayField(snapshot, "parts", "snapshot", validatePart);
  arrayField(snapshot, "runs", "snapshot", validateRun);
  arrayField(snapshot, "attempts", "snapshot", validateAttempt);
  if (snapshot.tasks !== undefined) arrayField(snapshot, "tasks", "snapshot", validateTask);
  arrayField(snapshot, "permissions", "snapshot", validatePermission);
  return snapshot as unknown as SessionStateSnapshot;
}

export function deserializeSessionStateSnapshot(text: string): SessionStateSnapshot {
  return decodeSessionStateSnapshot(parseJson(text));
}

export function serializeSessionStateSnapshot(snapshot: SessionStateSnapshot): string {
  decodeSessionStateSnapshot(snapshot);
  return JSON.stringify(snapshot);
}

export function decodeJobSnapshot(value: unknown): JobSnapshot {
  const job = object(value, "job");
  for (const field of ["id", "label", "ownerSession", "cwd"] as const) stringField(job, field, "job");
  enumField(job, "kind", "job", ["terminal", "shell", "agent", "dream", "workflow"] as const);
  enumField(job, "status", "job", ["running", "stopping", "completed", "killed", "failed"] as const);
  const capabilities = recordField(job, "capabilities", "job");
  for (const field of ["read", "wait", "send", "cancel"] as const) {
    booleanField(capabilities, field, "job.capabilities");
  }
  numberField(job, "startedAt", "job");
  numberField(job, "updatedAt", "job");
  optionalNumber(job, "finishedAt", "job");
  const exitCode = job.exitCode;
  if (exitCode !== undefined && exitCode !== null &&
    (typeof exitCode !== "number" || !Number.isInteger(exitCode))) {
    throw new ProtocolDataError("job.exitCode must be an integer or null", "job.exitCode");
  }
  optionalString(job, "detail", "job");
  optionalRecord(job, "metadata", "job");
  return job as unknown as JobSnapshot;
}

export function decodeJobReadResult(value: unknown): JobReadResult {
  const result = object(value, "jobReadResult");
  stringField(result, "text", "jobReadResult");
  numberField(result, "cursor", "jobReadResult");
  booleanField(result, "truncated", "jobReadResult");
  decodeJobSnapshot(result.snapshot);
  optionalRecord(result, "details", "jobReadResult");
  return result as unknown as JobReadResult;
}

export function decodeJobWaitResult(value: unknown): JobWaitResult {
  const result = object(value, "jobWaitResult");
  decodeJobReadResult(result);
  booleanField(result, "timedOut", "jobWaitResult");
  return result as unknown as JobWaitResult;
}

export function decodeTerminalSessionInfo(value: unknown): TerminalSessionInfo {
  const terminal = object(value, "terminal");
  for (const field of ["id", "name", "cwd", "shell", "createdAt"] as const) {
    stringField(terminal, field, "terminal");
  }
  const scope = recordField(terminal, "scope", "terminal");
  const scopeKind = enumField(scope, "kind", "terminal.scope", ["project", "session"] as const);
  if (scopeKind === "project") {
    const projectId = stringField(scope, "projectId", "terminal.scope");
    optionalString(terminal, "projectId", "terminal");
    if (terminal.projectId !== undefined && terminal.projectId !== projectId) {
      throw new ProtocolDataError(
        "terminal.projectId must match terminal.scope.projectId",
        "terminal.projectId",
      );
    }
  } else {
    const sessionId = stringField(scope, "sessionId", "terminal.scope");
    optionalString(terminal, "sessionId", "terminal");
    if (terminal.sessionId !== undefined && terminal.sessionId !== sessionId) {
      throw new ProtocolDataError(
        "terminal.sessionId must match terminal.scope.sessionId",
        "terminal.sessionId",
      );
    }
  }
  optionalString(terminal, "projectId", "terminal");
  optionalString(terminal, "sessionId", "terminal");
  enumField(terminal, "runtime", "terminal", ["local", "environment"] as const);
  enumField(terminal, "source", "terminal", ["user", "agent"] as const);
  enumField(terminal, "status", "terminal", ["running", "stopping", "completed", "killed", "failed"] as const);
  numberField(terminal, "cols", "terminal");
  numberField(terminal, "rows", "terminal");
  optionalString(terminal, "exitedAt", "terminal");
  optionalNumber(terminal, "exitCode", "terminal", true);
  return terminal as unknown as TerminalSessionInfo;
}

export function decodeTerminalEvent(value: unknown): TerminalEvent {
  const event = object(value, "terminalEvent");
  const type = enumField(event, "type", "terminalEvent", ["data", "status", "exit", "title", "error"] as const);
  stringField(event, "terminalId", "terminalEvent");
  if (type === "data") {
    stringField(event, "data", "terminalEvent");
    numberField(event, "sequence", "terminalEvent");
  } else if (type === "status") {
    enumField(event, "status", "terminalEvent", ["stopping", "killed"] as const);
  } else if (type === "exit") {
    optionalNumber(event, "exitCode", "terminalEvent", true);
    if (!("exitCode" in event)) {
      throw new ProtocolDataError("terminalEvent.exitCode is required", "terminalEvent.exitCode");
    }
  } else if (type === "title") {
    stringField(event, "title", "terminalEvent");
  } else {
    stringField(event, "message", "terminalEvent");
  }
  return event as unknown as TerminalEvent;
}

export function decodeTerminalReadResult(value: unknown): TerminalReadResult {
  const result = object(value, "terminalReadResult");
  stringField(result, "terminalId", "terminalReadResult");
  stringField(result, "data", "terminalReadResult");
  numberField(result, "sequence", "terminalReadResult");
  booleanField(result, "truncated", "terminalReadResult");
  return result as unknown as TerminalReadResult;
}

export function decodeTerminalWaitResult(value: unknown): TerminalWaitResult {
  const result = object(value, "terminalWaitResult");
  decodeTerminalReadResult(result);
  decodeTerminalSessionInfo(result.terminal);
  booleanField(result, "timedOut", "terminalWaitResult");
  return result as unknown as TerminalWaitResult;
}
