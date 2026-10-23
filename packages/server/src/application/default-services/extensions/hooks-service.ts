import type { HooksService } from "../../settings-api.js";
import type { DaemonSettingsRef } from "../shared.js";

export function createDefaultHooksService(ref: DaemonSettingsRef): HooksService {
  return {
    list({ cwd: _cwd }) {
      const settingsHooks = ref.current.hooks ?? [];
      return {
        hooks: settingsHooks.map((hook) => ({
          id: hook.id,
          event: hook.event,
          type: hook.type,
          enabled: hook.enabled !== false,
          origin: "settings" as const,
        })),
      };
    },
  };
}
