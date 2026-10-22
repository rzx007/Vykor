import { describe, expect, it } from "vitest";
import type { PluginAppRecord } from "@vykor/domain-contracts/plugin-apps";
import { pluginAppHostBinding, pluginAppHostInvocation } from "./plugin-app-host-binding.js";

function savedApp(overrides: Partial<PluginAppRecord> = {}): PluginAppRecord {
  return {
    id: "app-1", sessionId: "session-1", pluginId: "notes", pluginVersion: "1.0.0",
    pluginDigest: "plugin-digest", definitionDigest: "definition-digest",
    backendId: "notes-backend", backendKind: "native-tools", resourceUri: "ui://notes",
    origin: { kind: "surface", surfaceId: "notes-surface" }, logicalKey: "saved-logical-key",
    status: "open", controlRevision: 4, activeActionRunId: "active-run", lastActionRunId: "last-run",
    createdAt: 1, updatedAt: 2, ...overrides,
  };
}

describe("plugin app host binding", () => {
  it("selects the persisted identity without carrying mutable product state", () => {
    const app = savedApp();
    const expected = {
      agentId: "session-1", sessionId: "session-1", instanceId: "app-1",
      pluginId: "notes", pluginVersion: "1.0.0", pluginDigest: "plugin-digest",
      definitionDigest: "definition-digest", backendId: "notes-backend",
      backendKind: "native-tools", resourceUri: "ui://notes",
    };
    expect(pluginAppHostBinding(app)).toEqual(expected);
    expect(pluginAppHostBinding(savedApp({
      status: "revoked", controlRevision: 8, activeActionRunId: "other-run",
      lastActionRunId: "finished-run", updatedAt: 3,
    }))).toEqual(expected);
    expect(pluginAppHostBinding(app, "trusted-agent")).toEqual({ ...expected, agentId: "trusted-agent" });
  });

  it("keeps two instances of the same backend in one session distinct", () => {
    const first = pluginAppHostBinding(savedApp());
    const second = pluginAppHostBinding(savedApp({ id: "app-2" }));
    expect(second).toEqual({ ...first, instanceId: "app-2" });
    expect(second).not.toEqual(first);
  });

  it("takes invocation identity from the saved record and trusted agent argument", () => {
    const app = savedApp();
    const request = {
      lease: { token: "opaque-token", backendGeneration: "generation-1" },
      toolName: "notes.save", args: { content: "user content" },
      binding: { ...pluginAppHostBinding(app), pluginId: "forged-plugin", instanceId: "forged-instance" },
      agentId: "forged-agent", sessionId: "forged-session", pluginId: "forged-plugin",
    };
    expect(pluginAppHostInvocation(app, request, "trusted-agent")).toEqual({
      binding: pluginAppHostBinding(app, "trusted-agent"),
      lease: request.lease, toolName: request.toolName, args: request.args,
    });
  });
});
