import { describe, expect, it, vi } from "vitest";
import { createServiceRoutes } from "./service.js";

function createPluginRoutes() {
  const release = vi.fn();
  const acquireGlobalMutation = vi.fn(() => ({ release }));
  const acquireCwdMutation = vi.fn(() => ({ release }));
  const closeAllRuntimes = vi.fn(async () => {});
  const closeRuntimesForCwd = vi.fn(async () => {});
  const pluginService = {
    async list() {
      return { plugins: [], warnings: [] };
    },
    async setEnabled() {
      return { message: "updated", restartRuntimes: true };
    },
    async installLocal() {
      return { message: "installed", restartRuntimes: true };
    },
    async uninstall() {
      return { message: "uninstalled", restartRuntimes: true };
    },
  };
  const routes = createServiceRoutes({
    pluginService,
    control: {
      acquireGlobalMutation,
      acquireCwdMutation,
      closeAllRuntimes,
      closeRuntimesForCwd,
      invalidateRuntimes: vi.fn(async () => {}),
      runtimeInspectionAvailable: false,
      async inspectRuntimeHooks() {
        return [];
      },
      sessionExists() {
        return false;
      },
    },
  });
  return {
    routes,
    acquireGlobalMutation,
    acquireCwdMutation,
    closeAllRuntimes,
    closeRuntimesForCwd,
    release,
  };
}

function createUsageRoutes(usage: ReturnType<typeof vi.fn>) {
  return createServiceRoutes({
    contextService: {
      async preview() {
        return { report: "preview" };
      },
      async status() {
        return { report: "status" };
      },
      usage,
    },
    control: {
      acquireGlobalMutation: vi.fn(() => ({ release: vi.fn() })),
      acquireCwdMutation: vi.fn(() => ({ release: vi.fn() })),
      closeAllRuntimes: vi.fn(async () => {}),
      closeRuntimesForCwd: vi.fn(async () => {}),
      invalidateRuntimes: vi.fn(async () => {}),
      runtimeInspectionAvailable: false,
      async inspectRuntimeHooks() {
        return [];
      },
      sessionExists() {
        return false;
      },
    },
  });
}

describe("user-scoped plugin mutation routes", () => {
  it.each([
    ["/plugins/install-local", { sourcePath: "C:/plugin", scope: "user" }],
    ["/plugins/link-local", { sourcePath: "C:/plugin", scope: "user" }],
    ["/plugins/archive/install", { archivePath: "C:/plugin.zip", expectedArchiveDigest: "digest" }],
    ["/plugins/git/install", { url: "https://example.test/plugin.git", expectedSourceDigest: "digest" }],
  ] as const)("installs through %s during active work without closing runtimes or cancelling plugin actions", async (path, source) => {
    const acquireGlobalMutation = vi.fn(() => undefined);
    const closeAllRuntimes = vi.fn(async () => {});
    const invalidateRuntimes = vi.fn(async () => {});
    const withMutation = vi.fn(async <T>(_scope: unknown, work: () => Promise<T>): Promise<T> => work());
    const install = vi.fn(async () => ({ message: "Installed plugin 'dev.example'.", restartRuntimes: true }));
    const routes = createServiceRoutes({
      pluginService: { list: async () => ({ plugins: [], warnings: [] }), setEnabled: vi.fn(),
        installLocal: install, installArchive: install, installGit: install },
      pluginLifecycle: { withMutation },
      control: { ...createPluginControl(), acquireGlobalMutation, closeAllRuntimes, invalidateRuntimes },
    });
    const response = await routes.request(path, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "C:/workspace", approvedPermissions: [], ...source }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("下一次对话生效") });
    expect(install).toHaveBeenCalledOnce();
    expect(acquireGlobalMutation).not.toHaveBeenCalled();
    expect(closeAllRuntimes).not.toHaveBeenCalled();
    expect(withMutation).not.toHaveBeenCalled();
    expect(invalidateRuntimes).toHaveBeenCalledOnce();
  });
  it.each([
    [
      "enable",
      "/plugins/dev.example.plugin/enable",
      "POST",
      { cwd: "C:/workspace" },
    ],
    [
      "disable",
      "/plugins/dev.example.plugin/disable",
      "POST",
      { cwd: "C:/workspace" },
    ],
    [
      "uninstall",
      "/plugins/dev.example.plugin",
      "DELETE",
      { cwd: "C:/workspace" },
    ],
  ] as const)(
    "treats %s as a global runtime mutation",
    async (_operation, path, method, body) => {
      const context = createPluginRoutes();

      const response = await context.routes.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(200);
      expect(context.acquireGlobalMutation).toHaveBeenCalledOnce();
      expect(context.acquireCwdMutation).not.toHaveBeenCalled();
      expect(context.closeAllRuntimes).toHaveBeenCalledOnce();
      expect(context.closeRuntimesForCwd).not.toHaveBeenCalled();
      expect(context.release).toHaveBeenCalledOnce();
    },
  );
});

function createPluginControl() {
  return {
    acquireGlobalMutation: vi.fn(() => ({ release: vi.fn() })),
    acquireCwdMutation: vi.fn(() => undefined),
    closeAllRuntimes: vi.fn(async () => {}),
    closeRuntimesForCwd: vi.fn(async () => {}),
    invalidateRuntimes: vi.fn(async () => {}),
    runtimeInspectionAvailable: false,
    inspectRuntimeHooks: vi.fn(async () => []), sessionExists: vi.fn(() => false),
  };
}

describe("plugin archive routes", () => {
  it("previews without refreshing and schedules a soft refresh only after installation", async () => {
    const release = vi.fn();
    const acquireGlobalMutation = vi.fn(() => ({ release }));
    const closeAllRuntimes = vi.fn(async () => {});
    const invalidateRuntimes = vi.fn(async () => {});
    const previewArchive = vi.fn(async () => ({
      archiveDigest: "a".repeat(64), identity: { id: "dev.example.archive", name: "archive", version: "1" },
      requestedPermissions: [], approvalRequired: false, inventory: { skills: 1 }, diagnostics: [],
    }));
    const installArchive = vi.fn(async () => ({ message: "Installed plugin 'dev.example.archive'." }));
    const routes = createServiceRoutes({
      pluginService: { list: async () => ({ plugins: [], warnings: [] }), setEnabled: async () => ({ message: "" }), previewArchive, installArchive } as any,
      control: {
        acquireGlobalMutation, acquireCwdMutation: vi.fn(() => undefined), closeAllRuntimes, invalidateRuntimes,
        closeRuntimesForCwd: vi.fn(async () => {}), runtimeInspectionAvailable: false,
        inspectRuntimeHooks: vi.fn(async () => []), sessionExists: vi.fn(() => false),
      },
    });

    await expect((await routes.request("/plugins/archive/preview", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "C:/workspace", archivePath: "C:/archive.zip" }),
    })).json()).resolves.toMatchObject({ archiveDigest: "a".repeat(64) });
    expect(acquireGlobalMutation).not.toHaveBeenCalled();
    expect(invalidateRuntimes).not.toHaveBeenCalled();

    expect((await routes.request("/plugins/archive/install", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "C:/workspace", archivePath: "C:/archive.zip", expectedArchiveDigest: "a".repeat(64), approvedPermissions: [] }),
    })).status).toBe(200);
    expect(acquireGlobalMutation).not.toHaveBeenCalled();
    expect(closeAllRuntimes).not.toHaveBeenCalled();
    expect(invalidateRuntimes).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  it("returns a structured archive error for malformed JSON", async () => {
    const routes = createServiceRoutes({
      pluginService: { list: async () => ({ plugins: [], warnings: [] }), setEnabled: async () => ({ message: "" }), previewArchive: vi.fn() } as any,
      control: {
        ...createPluginControl(),
        acquireGlobalMutation: vi.fn(() => ({ release: vi.fn() })), acquireCwdMutation: vi.fn(() => undefined),
        closeAllRuntimes: vi.fn(async () => {}), closeRuntimesForCwd: vi.fn(async () => {}), runtimeInspectionAvailable: false,
        inspectRuntimeHooks: vi.fn(async () => []), sessionExists: vi.fn(() => false),
      },
    });

    const response = await routes.request("/plugins/archive/preview", { method: "POST", body: "{" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "plugin_archive_invalid_request",
      message: "Request body must be valid JSON",
    });
  });

  it("does not refresh or close runtimes when installation fails", async () => {
    const release = vi.fn();
    const closeAllRuntimes = vi.fn(async () => {});
    const invalidateRuntimes = vi.fn(async () => {});
    const routes = createServiceRoutes({
      pluginService: {
        list: async () => ({ plugins: [], warnings: [] }), setEnabled: async () => ({ message: "" }),
        installArchive: async () => { throw { body: { code: "plugin_archive_changed", message: "Select the archive again", diagnostics: [] } }; },
      } as any,
      control: {
        acquireGlobalMutation: vi.fn(() => ({ release })), acquireCwdMutation: vi.fn(() => undefined), closeAllRuntimes, invalidateRuntimes,
        closeRuntimesForCwd: vi.fn(async () => {}), runtimeInspectionAvailable: false,
        inspectRuntimeHooks: vi.fn(async () => []), sessionExists: vi.fn(() => false),
      },
    });

    const response = await routes.request("/plugins/archive/install", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "C:/workspace", archivePath: "C:/archive.zip", expectedArchiveDigest: "a".repeat(64), approvedPermissions: [] }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ code: "plugin_archive_changed", message: "Select the archive again", diagnostics: [] });
    expect(closeAllRuntimes).not.toHaveBeenCalled();
    expect(invalidateRuntimes).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("reports a committed install as successful even if idle runtime cleanup fails", async () => {
    const routes = createServiceRoutes({
      pluginService: { list: async () => ({ plugins: [], warnings: [] }), setEnabled: vi.fn(),
        installArchive: async () => ({ message: "Installed plugin 'dev.example'." }) },
      control: { ...createPluginControl(), invalidateRuntimes: async () => { throw new Error("cleanup failed"); } },
    });
    const response = await routes.request("/plugins/archive/install", { method: "POST",
      body: JSON.stringify({ cwd: "C:/workspace", archivePath: "C:/plugin.zip", expectedArchiveDigest: "digest", approvedPermissions: [] }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: expect.stringContaining("/reload-plugins") });
  });
});

describe("skill management routes", () => {
  it("lists skills and deletes through a global runtime mutation", async () => {
    const snapshot = { skills: [], projects: [], warnings: [] };
    const list = vi.fn(async () => snapshot);
    const remove = vi.fn(async () => snapshot);
    const release = vi.fn();
    const closeAllRuntimes = vi.fn(async () => {});
    const routes = createServiceRoutes({
      skillService: { list, remove },
      control: {
        acquireGlobalMutation: vi.fn(() => ({ release })),
        acquireCwdMutation: vi.fn(() => undefined),
        closeAllRuntimes,
        closeRuntimesForCwd: vi.fn(async () => {}),
        invalidateRuntimes: vi.fn(async () => {}),
        runtimeInspectionAvailable: false,
        inspectRuntimeHooks: vi.fn(async () => []),
        sessionExists: vi.fn(() => false),
      },
    });

    expect((await routes.request("/skills")).status).toBe(200);
    const removed = await routes.request("/skills/skill_a", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedContent: "current" }),
    });

    expect(removed.status).toBe(200);
    expect(list).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith({
      id: "skill_a",
      expectedContent: "current",
    });
    expect(closeAllRuntimes).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("blocks skill deletion while a global mutation is unavailable", async () => {
    const remove = vi.fn();
    const routes = createServiceRoutes({
      skillService: {
        list: async () => ({ skills: [], projects: [], warnings: [] }),
        remove,
      },
      control: {
        acquireGlobalMutation: vi.fn(() => undefined),
        acquireCwdMutation: vi.fn(() => undefined),
        closeAllRuntimes: vi.fn(async () => {}),
        closeRuntimesForCwd: vi.fn(async () => {}),
        invalidateRuntimes: vi.fn(async () => {}),
        runtimeInspectionAvailable: false,
        inspectRuntimeHooks: vi.fn(async () => []),
        sessionExists: vi.fn(() => false),
      },
    });

    expect(
      (
        await routes.request("/skills/a", {
          method: "DELETE",
          body: JSON.stringify({ expectedContent: "x" }),
        })
      ).status,
    ).toBe(409);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("GET /context/usage", () => {
  it("forwards cwd, sessionId, refresh, and previous window to ContextService.usage", async () => {
    const usage = vi.fn(async () => ({
      snapshot: { source: "static_only", tips: [] },
      report: "usage-report",
    }));
    const routes = createUsageRoutes(usage);

    const response = await routes.request(
      "/context/usage?cwd=C%3A%2Fworkspace&sessionId=s1&refresh=true&previousContextWindow=200000",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      snapshot: { source: "static_only", tips: [] },
      report: "usage-report",
    });
    expect(usage).toHaveBeenCalledWith({
      cwd: "C:/workspace",
      sessionId: "s1",
      refresh: true,
      previousContextWindow: 200_000,
    });
  });

  it("returns snapshot and report from ContextService.usage", async () => {
    const usage = vi.fn(async () => ({
      snapshot: {
        model: "m",
        contextWindow: 1000,
        estimatedInputTokens: 10,
        percentFull: 0.01,
        estimator: "heuristic_v1" as const,
        buckets: [],
        tips: [],
        computedAt: "2026-09-05T00:00:00.000Z",
        source: "static_only" as const,
      },
      report: "USAGE REPORT",
    }));
    const routes = createUsageRoutes(usage);

    const response = await routes.request(
      "/context/usage?cwd=/tmp/project&sessionId=s1&refresh=true",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.report).toBe("USAGE REPORT");
    expect(body.snapshot.source).toBe("static_only");
    expect(usage).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      sessionId: "s1",
      refresh: true,
    });
  });

  it("requires cwd", async () => {
    const routes = createUsageRoutes(
      vi.fn(async () => ({ snapshot: {} as never, report: "" })),
    );
    const response = await routes.request("/context/usage");
    expect(response.status).toBe(400);
  });
});
