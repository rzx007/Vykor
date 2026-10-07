import {
  updateSettings,
  SettingsConflictError,
  type Settings,
} from "@vykor/core";
import { isDeepStrictEqual } from "node:util";
import { normalizeSandboxConfig } from "@vykor/sandbox";

export interface DaemonSettingsRef {
  current: Settings;
  reload?: () => Promise<Settings> | Settings;
}

export function sanitizeSettings(settings: Settings): Record<string, unknown> {
  const { apiKey: _apiKey, ...rest } = settings as Settings & { apiKey?: string };
  const copy = structuredClone(rest);
  for (const provider of copy.customProviders ?? []) {
    const secretNames = new Set(provider.secretHeaderNames?.map((name) => name.toLowerCase()) ?? []);
    if (provider.headers) provider.headers = Object.fromEntries(Object.entries(provider.headers).filter(([name]) => !secretNames.has(name.toLowerCase())));
  }
  return copy as Record<string, unknown>;
}

export async function readCurrentSettings(ref: DaemonSettingsRef): Promise<Settings> {
  const loaded = ref.reload ? await ref.reload() : undefined;
  if (loaded) ref.current = loaded;
  return ref.current;
}

export function mergeSettingsPatch(current: Settings, patch: Record<string, unknown>): Settings {
  const next: Settings = {
    ...current,
    ...patch,
    permission: {
      ...current.permission,
      ...(isRecord(patch.permission) ? patch.permission : {}),
    },
    memory: {
      ...current.memory,
      ...(isRecord(patch.memory) ? patch.memory : {}),
    },
    sandbox: {
      ...current.sandbox,
      ...(isRecord(patch.sandbox) ? patch.sandbox : {}),
    },
    daemon: {
      ...current.daemon,
      ...(isRecord(patch.daemon) ? patch.daemon : {}),
    },
    plugins: {
      ...current.plugins,
      ...(isRecord(patch.plugins) ? patch.plugins : {}),
    },
  } as Settings;
  return next;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function saveSettingsAndRefreshRef(
  ref: DaemonSettingsRef,
  next: Settings,
  expected?: { permission?: unknown; sandbox?: unknown },
  patch?: Record<string, unknown>,
): Promise<void> {
  // `next` is the daemon's full desired state (built from its in-memory ref).
  // Writing it under the cross-process lock serializes against CLI / Desktop /
  // OAuth writers, and spreading `latest` first keeps any top-level key that a
  // concurrent writer added but this daemon snapshot does not manage.
  const merged = await updateSettings((latest) => {
    if (expected?.permission !== undefined && !isDeepStrictEqual(latest.permission, expected.permission)) {
      throw new SettingsConflictError("permission");
    }
    if (expected?.sandbox !== undefined && !isDeepStrictEqual(normalizeSandboxConfig(latest.sandbox), normalizeSandboxConfig(expected.sandbox as Settings["sandbox"]))) {
      throw new SettingsConflictError("sandbox");
    }
    return patch ? mergeSettingsPatch(latest, patch) : { ...latest, ...next };
  });
  ref.current = merged;
}
