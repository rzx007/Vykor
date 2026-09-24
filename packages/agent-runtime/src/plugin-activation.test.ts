import { describe, expect, it } from "vitest";
import type { HookDefinition } from "@vykor/core";
import type { LoadedNativePlugin } from "@vykor/plugins";

import { activateDiscoveredPlugins } from "./plugin-activation.js";

describe("plugin activation boundary", () => {
  it("activates an empty discovery without registering runtime resources", async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    const result = await activateDiscoveredPlugins({
      plugins: [],
      toolRegistry: {
        register() {},
        get() { return undefined; },
        getAll() { return []; },
        has() { return false; },
      },
      hookExecutor: { register() {} },
      addCleanup(cleanup) { cleanups.push(cleanup); },
    });

    expect(result).toEqual([]);
    expect(cleanups).toEqual([]);
  });

  it("rolls back hooks registered before a later hook fails", async () => {
    const registered: string[] = [];
    const unregistered: string[] = [];
    const hooks: HookDefinition[] = [
      { id: "hook:first", event: "before_tool_call", type: "command", command: "first", enabled: true },
      { id: "hook:second", event: "before_tool_call", type: "command", command: "second", enabled: true },
    ];
    const plugin = {
      manifest: { id: "dev.vykor.hooks", name: "hooks", version: "1.0.0", schemaVersion: 1, components: { hooks: ["./hooks.json"] } },
      root: "C:/plugin",
      status: "loaded",
      components: { hooks: { status: "loaded", value: hooks, diagnostics: [] } },
      diagnostics: [],
    } as unknown as LoadedNativePlugin;

    await expect(activateDiscoveredPlugins({
      plugins: [plugin],
      cwd: "C:/workspace",
      toolRegistry: {
        register() {},
        get() { return undefined; },
        getAll() { return []; },
        has() { return false; },
      },
      hookExecutor: {
        register(hook) {
          if (hook.id === "hook:second") throw new Error("second hook failed");
          registered.push(hook.id);
        },
        unregister(id) { unregistered.push(id); },
      },
      addCleanup() {},
    })).rejects.toThrow("second hook failed");

    expect(registered).toEqual(["hook:first"]);
    expect(unregistered).toEqual(["hook:first"]);
  });
});