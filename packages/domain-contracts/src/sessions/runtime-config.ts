import type { ApprovalMode, WorkMode } from "@vykor/agent-contracts/permissions";
import { isReplyStyle, type ReplyStyle } from "@vykor/agent-contracts/reply-style";
import { DomainValidationError } from "../validation-error.js";
export type SessionApiFormat = "anthropic" | "openai";

export type SessionRuntimeConfig = {
  model: string;
  provider?: string;
  baseUrl?: string;
  apiFormat?: SessionApiFormat;
  permissionMode?: "default" | "plan" | "full_auto";
  approvalMode?: ApprovalMode;
  workMode?: WorkMode;
  maxTurns?: number;
  effort?: string;
  sessionMode?: "direct" | "coordinator";
  systemPrompt?: string;
  replyStyle?: ReplyStyle | "inherit";
  allowedTools?: string[];
  disallowedTools?: string[];
  pluginsEnabled?: boolean;
  pluginAutoSelectionEnabled?: boolean;
};

export type SessionRuntimeConfigPatch = Partial<SessionRuntimeConfig>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}


function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  if (!isRecord(runtime)) throw new DomainValidationError("metadata.runtime must be an object", "metadata.runtime");
  for (const [field, value] of Object.entries(runtime)) {
    let valid = false;
    switch (field) {
      case "model": case "provider": case "baseUrl": case "systemPrompt":
        valid = typeof value === "string"; break;
      case "apiFormat": valid = apiFormatValue(value) !== undefined; break;
      case "permissionMode": valid = permissionModeValue(value) !== undefined; break;
      case "approvalMode": valid = value === "ask" || value === "auto_review" || value === "full_access"; break;
      case "workMode": valid = (value === "execute" || value === "plan"); break;
      case "effort": valid = effortValue(value) !== undefined; break;
      case "replyStyle": valid = value === "inherit" || isReplyStyle(value); break;
      case "sessionMode": valid = sessionModeValue(value) !== undefined; break;
      case "maxTurns": valid = numberValue(value) !== undefined; break;
      case "pluginsEnabled": case "pluginAutoSelectionEnabled":
        valid = booleanValue(value) !== undefined; break;
      case "allowedTools": case "disallowedTools":
        valid = Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0); break;
    }
    if (!valid) {
      throw new DomainValidationError(`Invalid runtime config field metadata.runtime.${field}`, `metadata.runtime.${field}`);
    }
  }
  return runtime;
}

export function readSessionRuntimeRevision(
  metadata: Record<string, unknown> | undefined,
): number {
  const revision = metadata?.runtimeRevision;
  if (revision === undefined) return 0;
  if (
    typeof revision !== "number"
    || !Number.isSafeInteger(revision)
    || revision < 0
  ) {
    throw new DomainValidationError(
      "metadata.runtimeRevision must be a non-negative safe integer",
      "metadata.runtimeRevision",
    );
  }
  return revision;
}
