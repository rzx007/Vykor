import type { SessionRecord } from "@vykor/domain-contracts/sessions";
import { isReplyStyle } from "@vykor/agent-contracts";
import { readRuntimeMetadata, type SessionApiFormat, type SessionRuntimeConfig, type SessionRuntimeConfigPatch } from "@vykor/domain-contracts/sessions/runtime-config";
import { isWorkMode, normalizeApprovalMode } from "@vykor/host-config";
import { effectivePermissionMode } from "@vykor/permissions";
const RUNTIME_CONFIG_KEYS: Array<keyof SessionRuntimeConfig> = [
  "model",
  "provider",
  "baseUrl",
  "apiFormat",
  "permissionMode",
  "approvalMode",
  "workMode",
  "maxTurns",
  "effort",
  "sessionMode",
  "systemPrompt",
  "replyStyle",
  "allowedTools",
  "disallowedTools",
  "pluginsEnabled",
  "pluginAutoSelectionEnabled",
];


function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length > 0 ? items : undefined;
}


function effortValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

function sessionModeValue(value: unknown): SessionRuntimeConfig["sessionMode"] | undefined {
  return value === "coordinator" ? "coordinator" : value === "direct" ? "direct" : undefined;
}

function apiFormatValue(value: unknown): SessionApiFormat | undefined {
  return value === "anthropic" || value === "openai" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function readSessionRuntimeConfig(
  session: SessionRecord,
  defaults?: Partial<SessionRuntimeConfig>,
): SessionRuntimeConfig {
  const runtime = readRuntimeMetadata(session.metadata);
  const model = stringValue(runtime.model);
  if (!model) {
    throw new Error(`Session runtime config is missing metadata.runtime.model: ${session.id}`);
  }
  const approvalMode = normalizeApprovalMode(runtime.approvalMode ?? runtime.permissionMode)
    ?? defaults?.approvalMode ?? normalizeApprovalMode(defaults?.permissionMode);
  const workMode = isWorkMode(runtime.workMode) ? runtime.workMode
    : runtime.permissionMode === "plan" ? "plan" : defaults?.workMode ?? "execute";
  return {
    model,
    ...(runtime.replyStyle !== undefined || defaults?.replyStyle !== undefined
      ? { replyStyle: isReplyStyle(runtime.replyStyle) ? runtime.replyStyle : defaults?.replyStyle ?? "inherit" }
      : {}),
    ...(approvalMode ? { approvalMode } : {}),
    ...(approvalMode || isWorkMode(runtime.workMode) || defaults?.workMode ? { workMode } : {}),
    ...(stringValue(runtime.provider) ?? defaults?.provider
      ? { provider: stringValue(runtime.provider) ?? defaults?.provider }
      : {}),
    ...(stringValue(runtime.baseUrl) ?? defaults?.baseUrl
      ? { baseUrl: stringValue(runtime.baseUrl) ?? defaults?.baseUrl }
      : {}),
    ...(apiFormatValue(runtime.apiFormat) ?? defaults?.apiFormat
      ? { apiFormat: apiFormatValue(runtime.apiFormat) ?? defaults?.apiFormat }
      : {}),
    ...(approvalMode
      ? { permissionMode: effectivePermissionMode(approvalMode, workMode) }
      : {}),
    ...((numberValue(runtime.maxTurns) ?? defaults?.maxTurns) !== undefined
      ? { maxTurns: numberValue(runtime.maxTurns) ?? defaults?.maxTurns }
      : {}),
    ...(effortValue(runtime.effort) ?? defaults?.effort
      ? { effort: effortValue(runtime.effort) ?? defaults?.effort }
      : {}),
    ...(sessionModeValue(runtime.sessionMode) ?? defaults?.sessionMode
      ? { sessionMode: sessionModeValue(runtime.sessionMode) ?? defaults?.sessionMode }
      : {}),
    ...(stringValue(runtime.systemPrompt) ?? defaults?.systemPrompt
      ? { systemPrompt: stringValue(runtime.systemPrompt) ?? defaults?.systemPrompt }
      : {}),
    ...(stringArrayValue(runtime.allowedTools) ?? defaults?.allowedTools
      ? { allowedTools: stringArrayValue(runtime.allowedTools) ?? defaults?.allowedTools }
      : {}),
    ...(stringArrayValue(runtime.disallowedTools) ?? defaults?.disallowedTools
      ? { disallowedTools: stringArrayValue(runtime.disallowedTools) ?? defaults?.disallowedTools }
      : {}),
    ...((booleanValue(runtime.pluginsEnabled) ?? defaults?.pluginsEnabled) !== undefined
      ? { pluginsEnabled: booleanValue(runtime.pluginsEnabled) ?? defaults?.pluginsEnabled }
      : {}),
    ...((booleanValue(runtime.pluginAutoSelectionEnabled) ?? defaults?.pluginAutoSelectionEnabled) !== undefined
      ? { pluginAutoSelectionEnabled: booleanValue(runtime.pluginAutoSelectionEnabled) ?? defaults?.pluginAutoSelectionEnabled }
      : {}),
  };
}

export function patchSessionRuntimeMetadata(
  metadata: Record<string, unknown>,
  patch: SessionRuntimeConfigPatch,
): Record<string, unknown> {
  const runtime = {
    ...readRuntimeMetadata(metadata),
    ...stripUndefined(patch),
  };
  // Canonicalize legacy metadata when a caller writes either new mode field.
  if (runtime.permissionMode !== undefined && (patch.approvalMode !== undefined || patch.workMode !== undefined)) {
    runtime.approvalMode ??= normalizeApprovalMode(runtime.permissionMode) ?? "ask";
    runtime.workMode ??= runtime.permissionMode === "plan" ? "plan" : "execute";
    delete runtime.permissionMode;
  }
  readRuntimeMetadata({ runtime });
  return {
    ...metadata,
    runtime,
  };
}

export function runtimeMetadataChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  return JSON.stringify(readRuntimeMetadata(before)) !== JSON.stringify(readRuntimeMetadata(after));
}

export function changedSessionRuntimeKeys(
  before: SessionRuntimeConfig,
  after: SessionRuntimeConfig,
): Array<keyof SessionRuntimeConfig> {
  return RUNTIME_CONFIG_KEYS.filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

function stripUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}
