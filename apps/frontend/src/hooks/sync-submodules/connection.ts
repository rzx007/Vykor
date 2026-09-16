import {
  OpenHarnessClient,
  readSessionRuntimeConfig,
  type SessionRecord,
} from "@openharness/client";

import type { FrontendConfig } from "../../types";

export interface DefaultRuntimeSettings {
  model: string;
  provider?: string;
  baseUrl?: string;
  apiFormat?: "anthropic" | "openai";
}

export function stringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function normalizeSessionMode(value: unknown): "coordinator" | null {
  return value === "coordinator" ? "coordinator" : null;
}

export function statusSessionMode(value: unknown): "coordinator" | "direct" {
  return normalizeSessionMode(value) ?? "direct";
}

export function shouldAutoActivateSession(
  session: SessionRecord,
  defaultModel: string,
  pluginsEnabled: boolean | undefined | null,
): boolean {
  const runtime = readSessionRuntimeConfig(session);
  return runtime.model === defaultModel
    && (pluginsEnabled == null || (runtime.pluginsEnabled ?? true) === pluginsEnabled);
}

export function createDaemonClient(daemon: FrontendConfig["daemon"]): OpenHarnessClient | null {
  if (!daemon?.url) return null;
  return new OpenHarnessClient({
    baseUrl: daemon.url,
    token: daemon.token ?? undefined,
  });
}
