import type {
  PluginCapabilityInventory,
} from "@openharness/agent-runtime";
import type {
  SessionRecord,
  SessionUserInputItem,
} from "@openharness/protocol";
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
    const hasReferences = items.some((item) =>
      item.type === "capability" || item.type === "skill"
    );
    if (!hasReferences) return {};

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

    if (pluginIds.size !== 1) {
      throw new SessionApplicationError(409, "session_plugin_capability_conflict");
    }
    return { pluginId: [...pluginIds][0] };
  }
}
