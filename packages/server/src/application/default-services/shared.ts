import {
  updateSettings,
  type Settings,
} from "@openharness/core";

export interface DaemonSettingsRef {
  current: Settings;
  reload?: () => Promise<Settings> | Settings;
}

export function sanitizeSettings(settings: Settings): Record<string, unknown> {
  const { apiKey: _apiKey, ...rest } = settings as Settings & { apiKey?: string };
  return structuredClone(rest) as Record<string, unknown>;
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
  next: Settings
): Promise<void> {
  const base = ref.current;
  const merged = await updateSettings((latest) =>
    applyTopLevelChanges(latest, base, next)
  );
  ref.current = merged;
}

/**
 * Persist the top-level fields that the daemon intentionally changed, leaving
 * fields a concurrent writer (CLI, Desktop, another settings window) touched in
 * between alone. Without this, a full-file write of a snapshot read before the
 * lock would silently discard those unrelated edits.
 */
function applyTopLevelChanges(
  latest: Settings,
  base: Settings,
  next: Settings
): Settings {
  const result = { ...latest } as unknown as Record<string, unknown>;
  const before = base as unknown as Record<string, unknown>;
  const after = next as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (after[key] === undefined) delete result[key];
    else result[key] = after[key];
  }
  return result as unknown as Settings;
}
