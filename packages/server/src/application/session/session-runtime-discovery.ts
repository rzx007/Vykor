import { discoverVykorExtensions } from "@vykor/agent-runtime";
import type { Settings } from "@vykor/core";
import type { SessionRecord } from "@vykor/protocol";
import { resolveSessionModelContextLimits } from "../assemble-session-context-usage.js";
import { createDefaultModelService } from "../default-services/model-service.js";

export interface SessionRuntimeDiscoveryOptions {
  settings?: Settings;
  getSettings?: () => Settings;
  getSettingsForCwd?: (cwd: string) => Promise<Settings>;
}

/** Shared discovery callbacks for session runtime and application assembly. */
export function createSessionRuntimeDiscovery(options: SessionRuntimeDiscoveryOptions) {
  const resolveSettings = async (cwd: string) =>
    options.getSettingsForCwd
      ? await options.getSettingsForCwd(cwd)
      : (options.getSettings?.() ?? options.settings);
  const discover = async (cwd: string, unavailable: string) => {
    const settings = await resolveSettings(cwd);
    if (!settings) throw new Error(unavailable);
    return { settings, extensions: await discoverVykorExtensions(cwd, settings) };
  };
  return {
    resolveSettings,
    resolveModelLimits: (session: SessionRecord, settings: Settings) =>
      resolveSessionModelContextLimits({
        session,
        settings,
        listProviders: () => createDefaultModelService({ current: settings }).list(),
      }),
    resolveSkillsList: async (cwd: string, settings: Settings) =>
      (await discoverVykorExtensions(cwd, settings)).skillRegistry.modelVisibleList(),
    resolveSkillCatalog: async (session: SessionRecord) =>
      (await discover(session.cwd, "session_input_skill_catalog_unavailable")).extensions.skillRegistry,
    resolvePluginInventory: async (session: SessionRecord) =>
      (await discover(session.cwd, "session_plugin_capability_unavailable")).extensions.pluginCapabilityInventory,
  };
}
