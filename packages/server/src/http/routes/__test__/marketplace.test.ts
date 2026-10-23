import { expect, it } from "vitest";
import { createMarketplaceRoutes } from "../marketplace.js";
it("delivers author presentation in the market catalog without leaking private fields", async () => {
  const plugin = { id: "example.notes", name: "notes", version: "1.0.0", category: "productivity", componentTypes: ["apps"],
    icon: "data:image/svg+xml;base64,PHN2Zy8+", introduction: "## 笔记", homepage: "https://example.com/notes",
    prompts: [{ title: "整理笔记", prompt: "整理现有笔记。", privatePath: "/private/example" }],
    artifact: { url: "https://example.com/notes.zip", sha256: "a".repeat(64), size: 42 }, requires: { host: ">=1.2.20" },
    source: { repository: "https://example.com/repository", commit: "b".repeat(40), path: "notes" }, privatePath: "/private/icon" };
  const app = createMarketplaceRoutes({ catalog: async () => ({ sources: [], entries: [
    { sourceId: "source", compatible: true, updateAvailable: false, plugin },
  ] }) } as never);
  const response = await app.request("/catalog?cwd=project");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.entries[0].plugin).toMatchObject({ icon: plugin.icon, introduction: plugin.introduction, homepage: plugin.homepage });
  expect(body.entries[0].plugin.prompts).toEqual([{ title: "整理笔记", prompt: "整理现有笔记。" }]);
  expect(body.entries[0].plugin).not.toHaveProperty("privatePath");
});
it.each(["preview", "install"])("rejects unknown %s request fields with a Protocol error", async route => {
  const app = createMarketplaceRoutes({
    preview: async () => ({}), install: async () => ({}),
  } as never);
  const response = await app.request(`/${route}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "project", sourceId: "source", pluginId: "plugin", version: "1.0.0",
      candidateId: "candidate", operationId: "operation", approvedPermissions: [], granted: true }) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
});
it("validates install input before reaching the service", async () => {
  let called = false;
  const app = createMarketplaceRoutes({
    install: async () => {
      called = true;
      throw new Error("must not run");
    },
  } as never);
  const response = await app.request("/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cwd: "project",
      candidateId: "candidate",
      operationId: "operation",
      approvedPermissions: [42],
    }),
  });
  expect(response.status).toBe(400);
  expect(called).toBe(false);
});
it("serves an install receipt without invoking lifecycle or runtime reload hooks", async () => {
  const receipt = {
    operationId: "operation-one",
    status: "installed",
    message: "已安装",
  };
  const app = createMarketplaceRoutes({
    install: async () => receipt,
    operation: async () => receipt,
  } as never);
  const response = await app.request("/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cwd: "project",
      candidateId: "candidate",
      operationId: "operation-one",
      approvedPermissions: [],
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(receipt);
  expect(await (await app.request("/operations/operation-one")).json()).toEqual(
    receipt,
  );
});

it("maps application results without leaking internal fields", async () => {
  const app = createMarketplaceRoutes({
    operation: async () => ({ operationId: "operation", status: "installed", message: "ok", cachePath: "/private/cache" }),
    sources: async () => ({ sources: [{ id: "source", name: "Source", url: "https://example.com", enabled: true,
      builtin: false, cachePath: "/private/cache" }], repository: { secret: true } }),
  } as never);
  expect(await (await app.request("/operations/operation")).json()).toEqual({ operationId: "operation", status: "installed", message: "ok" });
  expect(await (await app.request("/sources")).json()).toEqual({ sources: [{ id: "source", name: "Source", url: "https://example.com", enabled: true, builtin: false }] });
});
