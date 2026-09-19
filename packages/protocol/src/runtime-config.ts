import type { SessionRecord } from "./session.js";
import { ProtocolDataError } from "./serialization.js";

export type SessionApiFormat = "anthropic" | "openai";

export type SessionRuntimeConfig = {
  model: string;
  provider?: string;
  baseUrl?: string;
  apiFormat?: SessionApiFormat;
  permissionMode?: "default" | "plan" | "full_auto";
  maxTurns?: number;
  effort?: string;
  sessionMode?: "direct" | "coordinator";
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  pluginsEnabled?: boolean;
};

export type SessionRuntimeConfigPatch = Partial<SessionRuntimeConfig>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

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

function permissionModeValue(value: unknown): SessionRuntimeConfig["permissionMode"] | undefined {
  return value === "default" || value === "plan" || value === "full_auto" ? value : undefined;
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

export function readRuntimeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const runtime = metadata?.runtime;
  if (runtime === undefined) return {};
  if (!isRecord(runtime)) throw new ProtocolDataError("metadata.runtime must be an object", "metadata.runtime");
  for (const [field, value] of Object.entries(runtime)) {
    let valid = false;
    switch (field) {
      case "model": case "provider": case "baseUrl": case "systemPrompt":
        valid = typeof value === "string"; break;
      case "apiFormat": valid = apiFormatValue(value) !== undefined; break;
      case "permissionMode": valid = permissionModeValue(value) !== undefined; break;
      case "effort": valid = effortValue(value) !== undefined; break;
      case "sessionMode": valid = sessionModeValue(value) !== undefined; break;
      case "maxTurns": valid = numberValue(value) !== undefined; break;
      case "pluginsEnabled": valid = booleanValue(value) !== undefined; break;
      case "allowedTools": case "disallowedTools":
        valid = Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0); break;
    }
    if (!valid) {
      throw new ProtocolDataError(`Invalid runtime config field metadata.runtime.${field}`, `metadata.runtime.${field}`);
    }
  }
  return runtime;
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
  return {
    model,
    ...(stringValue(runtime.provider) ?? defaults?.provider
      ? { provider: stringValue(runtime.provider) ?? defaults?.provider }
      : {}),
    ...(stringValue(runtime.baseUrl) ?? defaults?.baseUrl
      ? { baseUrl: stringValue(runtime.baseUrl) ?? defaults?.baseUrl }
      : {}),
    ...(apiFormatValue(runtime.apiFormat) ?? defaults?.apiFormat
      ? { apiFormat: apiFormatValue(runtime.apiFormat) ?? defaults?.apiFormat }
      : {}),
    ...(permissionModeValue(runtime.permissionMode) ?? defaults?.permissionMode
      ? { permissionMode: permissionModeValue(runtime.permissionMode) ?? defaults?.permissionMode }
      : {}),
    ...(numberValue(runtime.maxTurns) ?? defaults?.maxTurns
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

function stripUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}
