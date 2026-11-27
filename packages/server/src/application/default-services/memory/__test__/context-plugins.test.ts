import { expect, it, vi } from "vitest";
import type { Settings } from "@vykor/host-config";
import { createDefaultContextService } from "../context-service.js";
import { createServiceRoutes } from "../../../../http/routes/service.js";

vi.mock("@vykor/agent-runtime", () => ({
  withSharedExtensionDiscovery: (operation: () => Promise<unknown>) => operation(),
  discoverVykorExtensions: async () => ({
    skillRegistry: { getAll: () => [] },
    pluginCapabilityInventory: {
      plugins: new Map([["dev.quality", {
        pluginId: "dev.quality", displayName: "Quality", description: "Review code",
        icon: "https://example.test/quality.png",
        version: "1.0.0", scope: "user", origin: "native",
        skillNames: ["review"], mcpServerIds: ["secret-server"], nativeToolEntries: ["/private/entry.js"], agentNames: [],
        permissions: ["secret"], path: "/private/plugin",
      }]]),
    },
  }),
}));

it("projects discovery winners into a catalog with no paths, permissions or server IDs", async () => {
  const service = createDefaultContextService({ current: {} as Settings });
  expect(typeof service.plugins).toBe("function");
  const result = await service.plugins!({ cwd: "/repo" });
  expect(result).toEqual({ plugins: [{
    pluginId: "dev.quality", displayName: "Quality", description: "Review code",
    icon: "https://example.test/quality.png",
    version: "1.0.0", scope: "user", origin: "native", capabilities: ["skills", "tools"],
  }] });
});

it("returns the composer catalog when its session usage cannot be read", async () => {
  const assembleLive = vi.fn(async () => { throw new Error("fixture usage failed"); });
  const routes = createServiceRoutes({
    contextService: createDefaultContextService({ current: {} as Settings }, undefined, { assembleLive }),
    control: { acquireComposerCatalogUsage: () => ({ release() {} }) } as Parameters<typeof createServiceRoutes>[0]["control"],
  });
  const response = await routes.request("/context/composer-catalog?cwd=/repo&sessionId=missing-usage");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    commands: expect.arrayContaining([expect.objectContaining({ name: "/status" })]),
    plugins: [expect.objectContaining({ pluginId: "dev.quality" })],
    contextUsage: null,
  });
  expect(assembleLive).toHaveBeenCalledWith({ cwd: "/repo", sessionId: "missing-usage" });
});

it("serves the scoped catalog through the context endpoint", async () => {
  const routes = createServiceRoutes({
    contextService: createDefaultContextService({ current: {} as Settings }),
    control: {} as Parameters<typeof createServiceRoutes>[0]["control"],
  });
  expect((await routes.request("/context/plugins")).status).toBe(400);
  const response = await routes.request("/context/plugins?cwd=/repo");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ plugins: [{
    pluginId: "dev.quality", displayName: "Quality", description: "Review code",
    icon: "https://example.test/quality.png",
    version: "1.0.0", scope: "user", origin: "native", capabilities: ["skills", "tools"],
  }] });
});
