import { loadSettings, type Settings, type StreamingMessageClient } from "@vykor/core";
import { CredentialStorage } from "@vykor/auth";
import { resolveApiClient } from "../../packages/agent-runtime/src/default-runtime-provider.js";
import type { BehaviorCase } from "./cases.js";

export interface LiveConfig {
  provider: string; model: string; caseIds: string[]; repeats: number;
  maxRequests: number; maxTurns: number; maxResponseTokens: number; timeoutMs: number;
}

export function parseLiveConfig(raw: unknown, cases: readonly BehaviorCase[]): LiveConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Live config must be an object");
  const data = raw as Record<string, unknown>;
  const keys = ["provider", "model", "caseIds", "repeats", "maxRequests", "maxTurns", "maxResponseTokens", "timeoutMs"];
  if (Object.keys(data).some((key) => !keys.includes(key))) throw new Error("Unexpected live config field");
  if (data.provider !== "opencode-go" || data.model !== "deepseek-v4.1-flash") {
    throw new Error("Live evaluation requires opencode-go / deepseek-v4.1-flash");
  }
  if (!Array.isArray(data.caseIds) || data.caseIds.length === 0 ||
      data.caseIds.some((id) => typeof id !== "string" || !cases.some((item) => item.id === id)) ||
      new Set(data.caseIds).size !== data.caseIds.length) {
    throw new Error("Live evaluation requires unique known case IDs");
  }
  for (const name of ["repeats", "maxRequests", "maxTurns", "maxResponseTokens", "timeoutMs"] as const) {
    if (!Number.isSafeInteger(data[name]) || (data[name] as number) < 1) throw new Error(`Live ${name} must be a positive safe integer`);
  }
  const caps = { maxRequests: 25, maxTurns: 20, maxResponseTokens: 8192, timeoutMs: 120_000 };
  for (const name of Object.keys(caps) as Array<keyof typeof caps>) {
    if ((data[name] as number) > caps[name]) throw new Error(`Live ${name} exceeds the absolute cap`);
  }
  if (!Number.isSafeInteger((data.maxRequests as number) * 12 * (data.repeats as number) * data.caseIds.length)) {
    throw new Error("Live total HTTP request upper bound is too large");
  }
  return data as unknown as LiveConfig;
}

export async function loadLiveClient(config: LiveConfig, deps: {
  settings?: Settings;
  storage?: { loadApiKey(provider: string): Promise<string | undefined> };
  resolve?: typeof resolveApiClient;
} = {}): Promise<{ client: StreamingMessageClient; report: {
  provider: string; model: string; adapterRetryLimit: number; sdkRetryLimit: number;
  maxHttpRequestsPerCase: number; providerBilling: "unknown";
}; redactions: string[] }> {
  const settings = deps.settings ?? await loadSettings({});
  const provider = settings.customProviders?.find((item) => item.id === config.provider);
  if (!provider || !provider.baseUrl || provider.apiFormat !== "openai") throw new Error("Configured live provider is unavailable or invalid");
  if (!provider.models.some((item) => item.id === config.model)) throw new Error("Configured live model is unavailable");
  const storage = deps.storage ?? new CredentialStorage();
  const apiKey = await storage.loadApiKey(config.provider);
  if (!apiKey) throw new Error("Configured live provider credential is missing");
  const client = await (deps.resolve ?? resolveApiClient)(
    { ...settings, apiKey: undefined },
    { provider: config.provider, model: config.model, apiKey, apiFormat: "openai", baseUrl: provider.baseUrl },
    storage as CredentialStorage,
  );
  return {
    client,
    redactions: [apiKey, ...Object.values(provider.headers ?? {})].filter((value) => value.length > 0),
    // Four adapter attempts, each with the OpenAI SDK's default three HTTP attempts.
    report: { provider: config.provider, model: config.model, adapterRetryLimit: 3, sdkRetryLimit: 2,
      maxHttpRequestsPerCase: config.maxRequests * 4 * 3, providerBilling: "unknown" },
  };
}

export function scrubLiveResult<T>(result: T, secrets: string[]): T {
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") return secrets.reduce((text, secret) => secret ? text.replaceAll(secret, "[REDACTED]") : text, value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, /^(?:headers?|authorization|api[-_]?key|x-api-key)$/i.test(key) ? "[REDACTED]" : redact(item)]));
    return value;
  };
  return redact(result) as T;
}

export function formatLiveFailure(result: { status: string; reason: string }, secrets: string[]): string {
  const safe = scrubLiveResult(result, secrets);
  return `${safe.status}: ${safe.reason}`;
}
