import { describe, expect, it } from "vitest";
import * as sdk from "../index.js";

describe("public Agent lifecycle boundary", () => {
  it("connects only on demand and has no product administration resources", () => {
    let requests = 0;
    const client = new sdk.VykorClient({
      baseUrl: "http://daemon.example",
      fetch: async () => { requests++; throw new Error("unexpected request"); },
    });
    expect(requests).toBe(0);
    for (const name of ["notes", "channels", "schedules", "plugins", "pluginApps", "pluginUiHistory", "system", "providers", "auth", "projects", "development", "terminals", "mcp"]) {
      expect(name in client, `public client exposes product resource ${name}`).toBe(false);
    }
    for (const name of ["protocol", "runtime", "sessions", "permissions", "attachments", "jobs", "events", "files"]) {
      expect(name in client, `missing lifecycle resource ${name}`).toBe(true);
    }
  });

  it("does not expose application rules or storage maintenance through the SDK", () => {
    const client = new sdk.VykorClient({ baseUrl: "http://daemon.example" });
    for (const name of ["NoteResource", "ChannelResource", "ScheduleResource", "PluginResource", "PluginAppResource", "SystemResource", "ProviderResource", "AuthResource", "DevelopmentResource", "TerminalResource", "mergeNotes", "dispatchSessionCommand", "LOCAL_COMMAND_DETAILS", "officeFormat", "getPluginAppToolPolicy"]) {
      expect(name in sdk, `public SDK exports product symbol ${name}`).toBe(false);
    }
    for (const name of ["scanStorage", "repairStorage", "gcStorage"]) expect(name in client.attachments).toBe(false);
    expect("clearWorktreeBinding" in client.sessions).toBe(false);
  });

  it("returns only lifecycle fields from an application-enriched session snapshot", async () => {
    const snapshot = {
      cursor: 1,
      session: { id: "s", cwd: "/repo", title: "Agent", model: "test", status: "idle", metadata: {}, createdAt: 1, updatedAt: 1 },
      inputs: [], messages: [], parts: [], runs: [], attempts: [], tasks: [], permissions: [],
      pluginApps: [{ id: "private-app" }],
    };
    const client = new sdk.VykorClient({ baseUrl: "http://daemon.example", fetch: async url =>
      Response.json(String(url).endsWith("/capabilities")
        ? { serverVersion: "test", protocol: { version: sdk.CURRENT_PROTOCOL_VERSION }, features: {} }
        : snapshot) });
    const result = await client.sessions.getState("s");
    expect(result.session.id).toBe("s");
    expect(result).not.toHaveProperty("pluginApps");
  });
});
