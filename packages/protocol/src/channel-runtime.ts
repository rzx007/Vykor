export type ChannelRuntimeState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export type ChannelDomain = "feishu" | "lark";

export interface ChannelConnectorRuntimeStatus {
  connector: string;
  enabled: boolean;
  state: ChannelRuntimeState;
  accountId?: string;
  domain?: ChannelDomain;
  botName?: string;
  startedAt?: number;
  lastError?: string;
}

export interface ChannelDenialNotice {
  connector: string;
  sender: string;
  chatId: string;
  at: number;
  seq: number;
}

export interface ChannelRuntimeStatus {
  bootId: string;
  connectors: ChannelConnectorRuntimeStatus[];
  recentDenials: ChannelDenialNotice[];
}

export interface FeishuChannelSnapshot {
  configured: boolean;
  enabled: boolean;
  appId?: string;
  domain?: ChannelDomain;
  botName?: string;
  allowFrom: Array<{ name: string; id: string }>;
  replyAtBotNames?: string[];
  sendProgress?: boolean;
  sendToolHints?: boolean;
}

export type FeishuRegistrationState =
  | "idle"
  | "starting"
  | "qr_ready"
  | "polling"
  | "slow_down"
  | "domain_switched"
  | "succeeded"
  | "expired"
  | "cancelled"
  | "error";

export interface FeishuRegistrationSnapshot {
  state: FeishuRegistrationState;
  attempt: number;
  domain: ChannelDomain;
  qrUrl?: string;
  expiresAt?: number;
  remainingSeconds?: number;
  pollIntervalMs?: number;
  error?: { code: string; message: string };
  warning?: string;
}

export interface ChannelRuntimeControlInput {
  connector?: string;
}

export interface FeishuConnectInput {
  appId: string;
  appSecret: string;
  domain?: ChannelDomain;
}

export interface FeishuAllowInput {
  id: string;
  name?: string;
}

export interface FeishuPatchInput {
  enabled?: boolean;
  sendProgress?: boolean;
  sendToolHints?: boolean;
}

export interface FeishuRegistrationStartInput {
  domain?: ChannelDomain;
}

export function parseChannelRuntimeControlInput(
  value: unknown,
): ChannelRuntimeControlInput {
  if (value === undefined || value === null) return {};
  const row = record(value);
  const connector = optional(row, "connector");
  return { ...(connector ? { connector } : {}) };
}

export function parseFeishuConnectInput(value: unknown): FeishuConnectInput {
  const row = record(value);
  const domain = optionalDomain(row);
  return {
    appId: required(row, "appId"),
    appSecret: required(row, "appSecret"),
    ...(domain ? { domain } : {}),
  };
}

export function parseFeishuAllowInput(value: unknown): FeishuAllowInput {
  const row = record(value);
  const id = required(row, "id");
  if (!/^(?:ou|oc)_[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("id must start with ou_ or oc_");
  }
  const name = optional(row, "name");
  return { id, ...(name ? { name } : {}) };
}

const PATCH_KEYS = ["enabled", "sendProgress", "sendToolHints"] as const;

export function parseFeishuPatchInput(value: unknown): FeishuPatchInput {
  const row = record(value);
  for (const key of Object.keys(row)) {
    if (!(PATCH_KEYS as readonly string[]).includes(key)) {
      throw new Error(`unknown field: ${key}`);
    }
  }
  const patch: FeishuPatchInput = {};
  for (const key of PATCH_KEYS) {
    const raw = row[key];
    if (raw === undefined) continue;
    if (typeof raw !== "boolean") throw new Error(`${key} must be a boolean`);
    patch[key] = raw;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("at least one of enabled, sendProgress, sendToolHints is required");
  }
  return patch;
}

export function parseFeishuRegistrationStartInput(
  value: unknown,
): FeishuRegistrationStartInput {
  if (value === undefined || value === null) return {};
  const row = record(value);
  const domain = optionalDomain(row);
  return { ...(domain ? { domain } : {}) };
}

function optionalDomain(row: Record<string, unknown>): ChannelDomain | undefined {
  const raw = row["domain"];
  if (raw === undefined || raw === null) return undefined;
  if (raw === "feishu" || raw === "lark") return raw;
  throw new Error("domain must be feishu or lark");
}

function record(value: unknown, field = "request body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function required(row: Record<string, unknown>, field: string): string {
  const value = optional(row, field);
  if (!value) throw new Error(`${field} is required`);
  return value;
}

function optional(row: Record<string, unknown>, field: string): string | undefined {
  const value = row[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}
