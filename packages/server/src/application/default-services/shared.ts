import {
  updateSettings,
  loadSettings,
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
  patch: Record<string, unknown>,
  expected?: { permission?: unknown; sandbox?: unknown; autoReviewMode?: "off" | "risk_based"; maxTurns?: number },
): Promise<void> {
  // Persist only the requested fields against durable defaults. Launch overrides
  // remain effective in the daemon, but must never become unrelated file edits.
  await updateSettings(async (latest) => {
    if (expected?.maxTurns !== undefined && latest.maxTurns !== expected.maxTurns) throw new SettingsConflictError("maxTurns");
    if (expected?.permission !== undefined && !isDeepStrictEqual(latest.permission, expected.permission)) {
      throw new SettingsConflictError("permission");
    }
    if (expected?.autoReviewMode !== undefined && (latest.autoReview?.mode ?? "off") !== expected.autoReviewMode) throw new SettingsConflictError("autoReview");
    if (expected?.sandbox !== undefined && !isDeepStrictEqual(normalizeSandboxConfig((await loadSettings()).sandbox), normalizeSandboxConfig(expected.sandbox as Settings["sandbox"]))) {
      throw new SettingsConflictError("sandbox");
    }
    return mergeSettingsPatch(latest, patch);
  }, { includeEnvironment: false });
  ref.current = ref.reload ? await ref.reload() : await loadSettings();
}
