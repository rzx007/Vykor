import { describe, expect, it, vi } from "vitest";
import { ProtocolValidationError } from "@vykor/protocol";
import { PluginAppDataError } from "@vykor/plugin-contracts/runtime-data";
import type { assemblePluginApps } from "../../../application/session/plugins/plugin-app-assembly.js";
import type { PluginAppConversationService } from "../../../application/session/plugins/plugin-app-conversation-service.js";
import { ApplicationError } from "../../../shared/application-error.js";
import { createSessionPluginAppsRoutes } from "../session-plugin-apps.js";

function fixture(error?: Error) {
  const invoke = vi.fn(async () => { throw error; });
  return { invoke, routes: createSessionPluginAppsRoutes({ actions: { invoke } } as unknown as ReturnType<typeof assemblePluginApps>, {} as PluginAppConversationService) };
}
const request = { source: { sessionId: "s", appId: "a" }, lease: { token: "t", backendGeneration: "g" },
  requestId: "r", expectedRevision: 0, toolName: "save", args: {} };

describe("plugin HTTP structured error classification", () => {
  it.each([
    new ProtocolValidationError("changed request wording", "args"),
    Object.assign(new PluginAppDataError("plugin_app_invalid_json"), { message: "changed JSON wording" }),
    Object.assign(new Error("separate runtime bundle"), { code: "plugin_app_invalid_cursor" }),
    Object.assign(new Error("separate runtime bundle"), { code: "plugin_app_invalid_policy" }),
    Object.assign(new Error("separate runtime bundle"), { code: "plugin_app_invalid_definition" }),
  ])("uses structured validation fields despite changed text: %s", async error => {
    const { routes } = fixture(error);
    const response = await routes.request("/s/plugin-apps/a/actions", { method: "POST", body: JSON.stringify(request) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "应用请求无效或已失效" });
  });

  it("does not classify an untyped runtime error by a validation-looking message", async () => {
    const { routes } = fixture(new Error("plugin_app_invalid_lookalike"));
    expect((await routes.request("/s/plugin-apps/a/actions", { method: "POST", body: JSON.stringify(request) })).status).toBe(409);
  });

  it.each(["{", "[]", JSON.stringify({ ...request, expectedRevision: -1 })])("rejects malformed input before application admission: %s", async body => {
    const { routes, invoke } = fixture();
    const response = await routes.request("/s/plugin-apps/a/actions", { method: "POST", body });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "应用请求无效或已失效" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps application errors and does not expose runtime failure details", async () => {
    const known = fixture(new ApplicationError(404, "missing record"));
    const response = await known.routes.request("/s/plugin-apps/a/actions", { method: "POST", body: JSON.stringify(request) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "missing record" });
    const unknown = fixture(Object.assign(new Error("private runtime detail"), { code: "unknown_runtime_failure" }));
    const failure = await unknown.routes.request("/s/plugin-apps/a/actions", { method: "POST", body: JSON.stringify(request) });
    expect(failure.status).toBe(409);
    expect(await failure.json()).toEqual({ error: "应用请求无效或已失效" });
  });
});
