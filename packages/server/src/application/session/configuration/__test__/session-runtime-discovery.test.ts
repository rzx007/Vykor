import type { SessionRecord } from "@vykor/domain-contracts/sessions";
import { describe, expect, it } from "vitest";

import { SessionPluginCapabilityService } from "../../plugins/session-plugin-capability-service.js";
import { createSessionRuntimeDiscovery } from "../session-runtime-discovery.js";

const session: SessionRecord = {
  id: "missing-settings-session",
  title: "Missing settings",
  cwd: process.cwd(),
  model: "scripted-client",
  status: "idle",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
};

describe("session runtime discovery without settings", () => {
  it("returns an empty plugin inventory when the host provides no settings", async () => {
    const discovery = createSessionRuntimeDiscovery({});
    const inventory = await discovery.resolvePluginInventory(session);

    expect([...inventory.plugins]).toEqual([]);
    expect([...inventory.skills]).toEqual([]);
    expect([...inventory.agents]).toEqual([]);
    expect([...inventory.mcpServers]).toEqual([]);
    expect([...inventory.nativeToolEntries]).toEqual([]);
    expect(inventory.diagnostics).toEqual([]);
  });

  it.each(["global", "cwd"] as const)("propagates %s settings read errors instead of treating them as missing settings", async source => {
    const failure = new Error("settings read failed");
    const discovery = createSessionRuntimeDiscovery(source === "global"
      ? { getSettings: () => { throw failure; } }
      : { getSettingsForCwd: async cwd => {
          expect(cwd).toBe(session.cwd);
          throw failure;
        } });

    await expect(discovery.resolvePluginInventory(session)).rejects.toBe(failure);
    const capabilities = new SessionPluginCapabilityService({ resolveInventory: discovery.resolvePluginInventory });
    await expect(capabilities.captureScope(session)).rejects.toBe(failure);
  });
});
