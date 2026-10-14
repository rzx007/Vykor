import type {
  PluginCapabilityInventory,
} from "@vykor/agent-runtime";
import type {
  SessionRecord,
  SessionUserInputItem,
} from "@vykor/protocol";
import { readRuntimeMetadata } from "@vykor/protocol";
import { SessionApplicationError } from "./session-application-error.js";

export interface SessionPluginCapabilityServiceContext {
  resolveInventory(session: SessionRecord): Promise<PluginCapabilityInventory>;
}

export class SessionPluginCapabilityService {
  constructor(private readonly context: SessionPluginCapabilityServiceContext) {}

  async admit(
    session: SessionRecord,
    items: readonly SessionUserInputItem[],
  ): Promise<{ pluginId?: string }> {
    const activePluginId = typeof session.metadata?.activePluginId === "string"
      ? session.metadata.activePluginId : undefined;
    const pluginsEnabled = readRuntimeMetadata(session.metadata ?? {}).pluginsEnabled !== false;
    const hasReferences = items.some((item) =>
      item.type === "capability" || item.type === "skill"
    );
    if (!hasReferences && (!activePluginId || !pluginsEnabled)) return {};

    const inventory = await this.context.resolveInventory(session);
    const pluginIds = new Set<string>();
    for (const item of items) {
      if (item.type === "skill") {
        const owner = inventory.skills.get(item.name);
        if (!owner || owner.path !== item.path) {
          if (item.source !== "plugin") continue;
          throw new SessionApplicationError(409, "session_plugin_capability_unavailable");
        }
        if (!inventory.plugins.has(owner.pluginId)) {
          throw new SessionApplicationError(409, "session_plugin_capability_unavailable");
        }
        pluginIds.add(owner.pluginId);
        continue;
      }
      if (item.type !== "capability") continue;

      if (!inventory.plugins.has(item.pluginId)) {
        throw new SessionApplicationError(409, "session_plugin_capability_unavailable");
      }
      if (
        item.kind === "plugin_agent" &&
        inventory.agents.get(item.agentId)?.pluginId !== item.pluginId
      ) {
        throw new SessionApplicationError(409, "session_plugin_capability_unavailable");
      }
      pluginIds.add(item.pluginId);
    }

    if (pluginIds.size > 1) {
      throw new SessionApplicationError(409, "session_plugin_capability_conflict");
    }
    // An explicit reference switches the selection; an ordinary turn keeps it.
    const explicitPluginId = [...pluginIds][0];
    if (explicitPluginId && !pluginsEnabled) {
      throw new SessionApplicationError(409, "session_plugin_capability_unavailable");
    }
    // A disabled, removed, or globally suspended plugin must not block ordinary
    // chat. Retain the identity so enabling it again can restore the selection.
    const pluginId = explicitPluginId ?? (pluginsEnabled && activePluginId && inventory.plugins.has(activePluginId)
      ? activePluginId : undefined);
    return pluginId ? { pluginId } : {};
  }
}
