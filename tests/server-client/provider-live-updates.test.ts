import { describe, expect, it, vi } from "vitest";
import { createSystemRoutes } from "../../packages/server/src/http/routes/system.js";
import { createAuthRoutes } from "../../packages/server/src/http/routes/auth.js";
import { VykorClient } from "@rzx/client";

function controls() {
  return {
    acquireGlobalMutation: vi.fn(() => undefined),
    closeAllRuntimes: vi.fn(async () => {}),
    invalidateRuntimes: vi.fn(async () => {}),
  };
}

describe("provider configuration during active runs", () => {
  it("serializes provider and auth saves without preventing active runs", async () => {
    const control = controls();
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    const blocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    let values: string[] = [];
    const routes = createSystemRoutes({
      control: control as never,
      providerService: {
        list: () => [],
        create: async () => {
          const previous = [...values];
          firstStarted();
          await blocked;
          values = [...previous, "custom"];
          return { name: "custom", displayName: "Custom", active: false, hasKey: true };
        },
      },
    });
    const auth = createAuthRoutes({ control, authService: {
      status: vi.fn(), logout: vi.fn(),
      login: async () => { values = [...values, "builtin"]; return { message: "ok" }; },
    } });
    const custom = routes.request("/providers/custom", { method: "POST", body: "{}" });
    await started;
    const builtin = auth.request("/login", { method: "POST", body: JSON.stringify({ provider: "openai" }) });
    // Allow an unqueued login to finish while the first save is paused.
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseFirst();
    expect((await Promise.all([custom, builtin])).map(response => response.status)).toEqual([201, 200]);
    expect(values).toEqual(["custom", "builtin"]);
  });

  it("passes an explicit client refresh through HTTP to the model service", async () => {
    const list = vi.fn(async () => []);
    const control = controls();
    const routes = createSystemRoutes({ control: control as never, modelService: { list } });
    const client = new VykorClient({
      baseUrl: "http://models.test",
      fetch: async (url, init) => routes.request(new Request(url, init)),
    });
    await client.providers.listModels({ refresh: true });
    expect(list).toHaveBeenLastCalledWith({ refresh: true });
    expect(control.invalidateRuntimes).toHaveBeenCalledOnce();
    await client.providers.listModels();
    expect(list).toHaveBeenLastCalledWith();
    expect(control.invalidateRuntimes).toHaveBeenCalledOnce();
  });

  it.each([
    ["POST", "/providers/custom", { id: "remote" }, "create", 201],
    ["PATCH", "/providers/custom/remote", { displayName: "Updated" }, "update", 200],
    ["POST", "/providers/catalog/remote/connect", { apiKey: "new-key" }, "connectCatalog", 200],
    ["PATCH", "/providers/catalog/remote", { headers: { "X-Tenant": "team" } }, "updateCatalogHeaders", 200],
  ] as const)("allows %s %s without closing an active runtime", async (method, path, body, operation, status) => {
    const control = controls();
    const save = vi.fn(async () => ({ name: "remote", displayName: "Remote", hasKey: true, active: false }));
    const routes = createSystemRoutes({
      control: control as never,
      providerService: { list: () => [], [operation]: save },
    });
    const response = await routes.request(path, { method, body: JSON.stringify(body) });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ provider: { name: "remote" } });
    expect(save).toHaveBeenCalledOnce();
    expect(control.closeAllRuntimes).not.toHaveBeenCalled();
    expect(control.invalidateRuntimes).toHaveBeenCalledOnce();
  });

  it.each(["/providers/custom/remote", "/providers/catalog/remote/connect"])("keeps deletion of %s blocked during active work", async path => {
    const remove = vi.fn();
    const control = controls();
    const routes = createSystemRoutes({
      control: control as never,
      providerService: { list: () => [], remove, disconnectCatalog: remove },
    });
    expect((await routes.request(path, { method: "DELETE" })).status).toBe(409);
    expect(remove).not.toHaveBeenCalled();
  });

  it("updates a built-in provider key without interrupting current work", async () => {
    const control = controls();
    const login = vi.fn(async () => ({ message: "ok" }));
    const routes = createAuthRoutes({
      control,
      authService: { status: vi.fn(), login, logout: vi.fn() },
    });
    const response = await routes.request("/login", {
      method: "POST", body: JSON.stringify({ provider: "openai", apiKey: "new-key" }),
    });
    expect(response.status).toBe(200);
    expect(login).toHaveBeenCalledWith({ provider: "openai", apiKey: "new-key" });
    expect(control.closeAllRuntimes).not.toHaveBeenCalled();
    expect(control.invalidateRuntimes).toHaveBeenCalledOnce();
  });
});
