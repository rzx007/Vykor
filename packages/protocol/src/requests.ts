import { DomainValidationError, assertPromptMetadataAllowed as domainAssertPromptMetadataAllowed, parseSessionInputItems as domainParseSessionInputItems, parsePromptAttachments as domainParsePromptAttachments } from "@vykor/domain-contracts/inputs";
import { parsePluginAppComposerContexts } from "./plugin-apps.js";
import {
  readRuntimeMetadata,
} from "./runtime-config.js";
import type {
  AdmitPromptAttachmentInput,
  AdmitPromptInput,
  CreateScheduledTaskInput,
  CreateSessionInput,
  ForkSessionInput,
  ReplyPermissionInput,
  ScheduledPermissionProfile,
  ScheduledStopPolicy,
  UpdateScheduledTaskInput,
  UpdateSessionInput,
  ClearSessionWorktreeBindingInput,
} from "./session.js";
import type { SessionUserInputItem } from "./session-input-items.js";

export interface ProtocolError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  traceId?: string;
}

export class ProtocolValidationError extends Error {
  readonly code = "invalid_request";
  readonly details?: Record<string, unknown>;

  constructor(message: string, field?: string, reason?: string) {
    super(message);
    this.name = "ProtocolValidationError";
    this.details =
      field || reason !== undefined
        ? {
            ...(field ? { field } : {}),
            ...(reason !== undefined ? { reason } : {}),
          }
        : undefined;
  }

  toProtocolError(): ProtocolError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** Ordinary Prompt inputs cannot claim host-created UI instances or action Runs. */
export { withoutHostPluginMetadata } from "@vykor/domain-contracts/inputs";

export function assertPromptMetadataAllowed(input: { metadata?: unknown; runMetadata?: unknown }): void { adaptDomainInput(() => domainAssertPromptMetadataAllowed(input)); }

type JsonRecord = Record<string, unknown>;

export type AdmitPromptRequest = Omit<AdmitPromptInput, "sessionId">;
export type ReplyPermissionRequest = Omit<ReplyPermissionInput, "requestId"> & {
  decision?: "once" | "session";
};

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolValidationError("Request body must be a JSON object");
  }
  return value as JsonRecord;
}

function requiredString(body: JsonRecord, field: string): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new ProtocolValidationError(`${field} is required`, field);
  }
  return value;
}

function optionalString(body: JsonRecord, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ProtocolValidationError(`${field} must be a string`, field);
  }
  return value;
}

function optionalNumber(
  body: JsonRecord,
  field: string,
  options: { nullable?: boolean; integer?: boolean; minimum?: number } = {},
): number | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null && options.nullable) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (options.integer && !Number.isInteger(value)) ||
    (options.minimum !== undefined && value < options.minimum)
  ) {
    throw new ProtocolValidationError(`${field} must be a valid number`, field);
  }
  return value;
}

function optionalBoolean(body: JsonRecord, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ProtocolValidationError(`${field} must be a boolean`, field);
  }
  return value;
}

function optionalRecord(
  body: JsonRecord,
  field: string,
): Record<string, unknown> | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolValidationError(`${field} must be an object`, field);
  }
  return value as Record<string, unknown>;
}

function optionalStringArray(
  body: JsonRecord,
  field: string,
): string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new ProtocolValidationError(
      `${field} must be an array of strings`,
      field,
    );
  }
  return [...value] as string[];
}

function optionalEnum<const T extends readonly string[]>(
  body: JsonRecord,
  field: string,
  values: T,
): T[number] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value)) {
    throw new ProtocolValidationError(
      `${field} must be one of: ${values.join(", ")}`,
      field,
    );
  }
  return value as T[number];
}

function requiredEnum<const T extends readonly string[]>(
  body: JsonRecord,
  field: string,
  values: T,
): T[number] {
  const value = optionalEnum(body, field, values);
  if (value === undefined) {
    throw new ProtocolValidationError(`${field} is required`, field);
  }
  return value;
}

export function parseCreateSessionRequest(value: unknown): CreateSessionInput {
  const body = record(value);
  const cwd = requiredString(body, "cwd");
  const rawMetadata = optionalRecord(body, "metadata") ?? {};
  const runtime = readRuntimeMetadata(rawMetadata);
  const bodyModel = optionalString(body, "model");
  const model = typeof runtime.model === "string" ? runtime.model : bodyModel;
  if (!model) throw new ProtocolValidationError("model is required", "model");
  const id = optionalString(body, "id");
  const parentId = optionalString(body, "parentId");
  const projectId = optionalString(body, "projectId");
  const title = optionalString(body, "title");
  const agent = optionalString(body, "agent");
  const storage = optionalEnum(body, "storage", ["sqlite", "memory"] as const);

  return {
    cwd,
    model,
    metadata: { ...rawMetadata, runtime: { ...runtime, model } },
    ...(id !== undefined ? { id } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(storage !== undefined ? { storage } : {}),
  };
}

export function parseForkSessionRequest(value: unknown): ForkSessionInput {
  const body = record(value);
  const beforeMessageId = optionalString(body, "beforeMessageId");
  const afterMessageId = optionalString(body, "afterMessageId");
  const storage = optionalEnum(body, "storage", ["sqlite", "memory"] as const);
  const copyHistory = optionalBoolean(body, "copyHistory");
  if (
    copyHistory === false &&
    (beforeMessageId !== undefined || afterMessageId !== undefined)
  ) {
    throw new ProtocolValidationError(
      "copyHistory=false cannot select a fork point",
      "copyHistory",
    );
  }
  return {
    ...(copyHistory !== undefined ? { copyHistory } : {}),
    ...(beforeMessageId !== undefined ? { beforeMessageId } : {}),
    ...(afterMessageId !== undefined ? { afterMessageId } : {}),
    ...(storage !== undefined ? { storage } : {}),
  };
}

export function parseUpdateSessionRequest(value: unknown): UpdateSessionInput {
  const body = record(value);
  if ("storage" in body) {
    throw new ProtocolValidationError(
      "storage is selected when the session is created",
      "storage",
    );
  }
  if ("model" in body) {
    throw new ProtocolValidationError(
      "model must be changed through metadata.runtime.model",
      "model",
    );
  }
  const title = optionalString(body, "title");
  const metadata = optionalRecord(body, "metadata");
  readRuntimeMetadata(metadata);
  const rawAgent = body.agent;
  if (
    rawAgent !== undefined &&
    rawAgent !== null &&
    typeof rawAgent !== "string"
  ) {
    throw new ProtocolValidationError(
      "agent must be a string or null",
      "agent",
    );
  }
  return {
    ...(title !== undefined ? { title } : {}),
    ...(rawAgent !== undefined ? { agent: rawAgent as string | null } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

export function parseClearSessionWorktreeBindingRequest(
  value: unknown,
): ClearSessionWorktreeBindingInput {
  const body = record(value);
  for (const key of Object.keys(body))
    if (!["id", "path", "branch"].includes(key))
      throw new ProtocolValidationError(
        "Only the expected worktree binding may be supplied",
        key,
      );
  const result = {
    id: requiredString(body, "id"),
    path: requiredString(body, "path"),
    branch: requiredString(body, "branch"),
  };
  for (const [key, text] of Object.entries(result))
    if (!text.trim() || text.length > 4096 || text.includes("\0"))
      throw new ProtocolValidationError(
        "Expected worktree binding field is invalid",
        key,
      );
  return result;
}

export function parseAdmitPromptRequest(value: unknown): AdmitPromptRequest {
  const body = record(value);
  assertPromptMetadataAllowed(body);
  const id = optionalString(body, "id");
  const delivery = optionalEnum(body, "delivery", ["queue", "steer"] as const);
  const metadata = optionalRecord(body, "metadata");
  const attachments = parsePromptAttachments(body.attachments);
  return {
    ...(body.pluginAppContexts !== undefined ? { pluginAppContexts: parsePluginAppComposerContexts(body.pluginAppContexts) } : {}),
    items: parsePromptItems(body),
    attachments,
    ...(id !== undefined ? { id } : {}),
    ...(delivery !== undefined ? { delivery } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

export function parsePromptItems(value: unknown): SessionUserInputItem[] {
  const body = record(value);
  if (body.items !== undefined) return parseSessionInputItems(body.items);
  const content = optionalString(body, "content");
  if (content === undefined) {
    throw new ProtocolValidationError("items must be an array", "items");
  }
  return parseSessionInputItems([{ type: "text", text: content }]);
}

export function parseSessionInputItems(value: unknown): SessionUserInputItem[] { return adaptDomainInput(() => domainParseSessionInputItems(value)); }

export function parsePromptAttachments(value: unknown): AdmitPromptAttachmentInput[] { return adaptDomainInput(() => domainParsePromptAttachments(value)); }

export function parseReplyPermissionRequest(
  value: unknown,
): ReplyPermissionRequest {
  const body = record(value);
  const status = requiredEnum(body, "status", [
    "approved",
    "denied",
    "expired",
  ] as const);
  const decision = optionalEnum(body, "decision", ["once", "session"] as const);
  const clientId = optionalString(body, "clientId");
  const answer = optionalString(body, "answer");
  return {
    status,
    ...(decision !== undefined ? { decision } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(answer !== undefined ? { answer } : {}),
  };
}

function parsePermissionProfile(value: unknown): ScheduledPermissionProfile {
  const body = record(value);
  const mode = requiredEnum(body, "mode", [
    "read_only",
    "workspace_write",
    "full_access",
  ] as const);
  const network = optionalBoolean(body, "network");
  const allowedTools = optionalStringArray(body, "allowedTools");
  const deniedTools = optionalStringArray(body, "deniedTools");
  return {
    mode,
    ...(network !== undefined ? { network } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(deniedTools !== undefined ? { deniedTools } : {}),
  };
}

function parseStopPolicy(value: unknown): ScheduledStopPolicy {
  const body = record(value);
  const runOnce = optionalBoolean(body, "runOnce");
  const maxRuns = optionalNumber(body, "maxRuns", {
    integer: true,
    minimum: 1,
  });
  const stopWhenCompleted = optionalBoolean(body, "stopWhenCompleted");
  const expiresAt = optionalNumber(body, "expiresAt");
  return {
    ...(runOnce !== undefined ? { runOnce } : {}),
    ...(maxRuns !== undefined ? { maxRuns: maxRuns as number } : {}),
    ...(stopWhenCompleted !== undefined ? { stopWhenCompleted } : {}),
    ...(expiresAt !== undefined ? { expiresAt: expiresAt as number } : {}),
  };
}

function parseScheduleFields(
  body: JsonRecord,
): Partial<CreateScheduledTaskInput> {
  const id = optionalString(body, "id");
  const name = optionalString(body, "name");
  const description = optionalString(body, "description");
  const prompt = optionalString(body, "prompt");
  const recurrence = optionalString(body, "recurrence");
  const recurrenceFormat = optionalEnum(body, "recurrenceFormat", [
    "rrule",
    "once",
  ] as const);
  const timezone = optionalString(body, "timezone");
  const status = optionalEnum(body, "status", [
    "active",
    "paused",
    "completed",
  ] as const);
  const destination = optionalEnum(body, "destination", [
    "standalone",
    "chat",
  ] as const);
  const sessionId = optionalString(body, "sessionId");
  const projectPaths = optionalStringArray(body, "projectPaths");
  const executionMode = optionalEnum(body, "executionMode", [
    "local",
    "worktree",
  ] as const);
  const model = optionalString(body, "model");
  const effort = optionalString(body, "effort");
  const skillNames = optionalStringArray(body, "skillNames");
  const pluginNames = optionalStringArray(body, "pluginNames");
  const permissionProfile =
    body.permissionProfile === undefined
      ? undefined
      : parsePermissionProfile(body.permissionProfile);
  const overlapPolicy = optionalEnum(body, "overlapPolicy", [
    "skip",
    "queue",
  ] as const);
  const missedRunPolicy = optionalEnum(body, "missedRunPolicy", [
    "skip",
    "run_once",
  ] as const);
  const stopPolicy =
    body.stopPolicy === undefined
      ? undefined
      : parseStopPolicy(body.stopPolicy);
  const createdBy = optionalEnum(body, "createdBy", ["user", "agent"] as const);
  const createdFromSessionId = optionalString(body, "createdFromSessionId");
  return {
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(recurrence !== undefined ? { recurrence } : {}),
    ...(recurrenceFormat !== undefined ? { recurrenceFormat } : {}),
    ...(timezone !== undefined ? { timezone } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(destination !== undefined ? { destination } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(projectPaths !== undefined ? { projectPaths } : {}),
    ...(executionMode !== undefined ? { executionMode } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(skillNames !== undefined ? { skillNames } : {}),
    ...(pluginNames !== undefined ? { pluginNames } : {}),
    ...(permissionProfile !== undefined ? { permissionProfile } : {}),
    ...(overlapPolicy !== undefined ? { overlapPolicy } : {}),
    ...(missedRunPolicy !== undefined ? { missedRunPolicy } : {}),
    ...(stopPolicy !== undefined ? { stopPolicy } : {}),
    ...(createdBy !== undefined ? { createdBy } : {}),
    ...(createdFromSessionId !== undefined ? { createdFromSessionId } : {}),
  };
}

export function parseCreateScheduledTaskRequest(
  value: unknown,
): CreateScheduledTaskInput {
  const body = record(value);
  const parsed = parseScheduleFields(body);
  const nextRunAt = optionalNumber(body, "nextRunAt");
  return {
    ...parsed,
    name: requiredString(body, "name"),
    prompt: requiredString(body, "prompt"),
    recurrence: requiredString(body, "recurrence"),
    recurrenceFormat: requiredEnum(body, "recurrenceFormat", [
      "rrule",
      "once",
    ] as const),
    timezone: requiredString(body, "timezone"),
    destination: requiredEnum(body, "destination", [
      "standalone",
      "chat",
    ] as const),
    ...(nextRunAt !== undefined ? { nextRunAt: nextRunAt as number } : {}),
  };
}

export function parseUpdateScheduledTaskRequest(
  value: unknown,
): UpdateScheduledTaskInput {
  const body = record(value);
  if ("id" in body) {
    throw new ProtocolValidationError("id cannot be changed", "id");
  }
  const parsed = parseScheduleFields(body);
  const lastRunAt = optionalNumber(body, "lastRunAt", { nullable: true });
  const nextRunAt = optionalNumber(body, "nextRunAt", { nullable: true });
  const runCount = optionalNumber(body, "runCount", {
    integer: true,
    minimum: 0,
  });
  const { id: _id, ...patch } = parsed;
  return {
    ...patch,
    ...(lastRunAt !== undefined
      ? { lastRunAt: lastRunAt as number | null }
      : {}),
    ...(nextRunAt !== undefined
      ? { nextRunAt: nextRunAt as number | null }
      : {}),
    ...(runCount !== undefined ? { runCount: runCount as number } : {}),
  };
}

function adaptDomainInput<T>(read: () => T): T { try { return read(); } catch(error) { if (error instanceof DomainValidationError) throw new ProtocolValidationError(error.message, error.field, error.reason); throw error; } }
