/** Shared config value coercion for `/config set` and daemon settings patches. */

export function coerceConfigValue(key: string, value: string): unknown {
  switch (key) {
    case "model":
    case "apiFormat":
    case "baseUrl":
    case "systemPrompt":
    case "theme":
    case "outputStyle":
    case "effort":
    case "provider":
      return value;

    case "maxTurns":
    case "outputTokenMax":
    case "passes": {
      const n = parseInt(value, 10);
      return Number.isNaN(n) ? undefined : n;
    }

    case "verbose":
    case "fastMode":
    case "plugins.enabled":
    case "memory.enabled":
    case "memory.sessionMemoryEnabled":
    case "memory.autoExtractEnabled":
    case "memory.autoDreamEnabled":
    case "daemon.autoStart":
      if (value === "true" || value === "on") return true;
      if (value === "false" || value === "off") return false;
      return undefined;

    case "memory.maxFiles":
    case "memory.maxEntrypointLines":
    case "memory.autoDreamMinHours":
    case "memory.autoDreamMinSessions": {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }

    case "permission.mode":
      if (["default", "plan", "full_auto"].includes(value)) return value;
      return undefined;

    default:
      return value;
  }
}

export function buildSettingsPatch(
  settings: Record<string, unknown>,
  key: string,
  coerced: unknown,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (key.includes(".")) {
    const [head, ...rest] = key.split(".");
    const leaf = rest.join(".");
    if (!head || !leaf) {
      patch[key] = coerced;
      return patch;
    }
    const current = settings[head];
    const base = current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
    if (rest.length === 1) {
      base[leaf] = coerced;
      patch[head] = base;
      return patch;
    }
    // Only one nesting level is used by current /config keys.
    base[rest[0]!] = coerced;
    patch[head] = base;
    return patch;
  }
  patch[key] = coerced;
  return patch;
}
