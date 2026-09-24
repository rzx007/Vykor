import {
  updateSettings,
  type Settings,
} from "@vykor/core";

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
  // `next` is the daemon's full desired state (built from its in-memory ref).
  // Writing it under the cross-process lock serializes against CLI / Desktop /
  // OAuth writers, and spreading `latest` first keeps any top-level key that a
  // concurrent writer added but this daemon snapshot does not manage.
  const merged = await updateSettings((latest) => ({ ...latest, ...next }));
  ref.current = merged;
}
