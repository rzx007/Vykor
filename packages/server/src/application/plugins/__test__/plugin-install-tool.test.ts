import { describe, expect, it, vi } from "vitest";
import type { AgentPermissionDecision, AgentPermissionRequest } from "@vykor/agent-contracts";
import type { PluginService } from "../../settings-api.js";
import { createPluginInstallTool } from "../plugin-install-tool.js";

function service(): PluginService {
  return {
    list: vi.fn(async () => ({ plugins: [], warnings: [] })),
    setEnabled: vi.fn(async () => ({ message: "" })),
    previewArchive: vi.fn(async () => ({
      archiveDigest: "digest", identity: { id: "example.test", name: "test", version: "1.0.0" },
      requestedPermissions: ["filesystem:workspace:read"], approvalRequired: true,
      inventory: { skills: 1 }, diagnostics: [],
    })),
    installArchive: vi.fn(async () => ({ message: "Installed plugin 'example.test'." })),
    previewGit: vi.fn(async () => ({
      sourceDigest: "git-digest", url: "https://example.com/plugin.git", commit: "abc123",
      identity: { id: "example.git", name: "git", version: "2.0.0" },
      requestedPermissions: [], approvalRequired: false, inventory: { skills: 1 }, diagnostics: [],
    })),
    installGit: vi.fn(async () => ({ message: "Installed plugin 'example.git'." })),
  };
}

describe("PluginInstall", () => {
  it("installs with a standard permission host and no user-question host", async () => {
    const plugins = service();
    const requestPermission = vi.fn(async (_request: AgentPermissionRequest): Promise<AgentPermissionDecision> => ({ status: "approved" }));
    const result = await createPluginInstallTool(plugins, async () => {}).execute(
      { source: "archive", path: "C:/plugin.zip" }, { cwd: "C:/work", requestPermission },
    );
    expect(result.isError).toBeUndefined();
    expect(plugins.installArchive).toHaveBeenCalledOnce();
    expect(requestPermission).toHaveBeenCalledWith({
      toolName: "PluginInstall", reason: expect.stringContaining("filesystem:workspace:read"),
      input: {
        source: "archive", path: "C:/plugin.zip",
        preview: { identity: { id: "example.test", name: "test", version: "1.0.0" }, archiveDigest: "digest", requestedPermissions: ["filesystem:workspace:read"] },
      },
    });
  });
  it("previews before permission and pins the approved archive and permissions", async () => {
    const plugins = service();
    const invalidate = vi.fn(async () => {});
    const requestPermission = vi.fn(async (): Promise<AgentPermissionDecision> => {
      expect(plugins.previewArchive).toHaveBeenCalledOnce();
      expect(plugins.installArchive).not.toHaveBeenCalled();
      return { status: "approved" };
    });
    const tool = createPluginInstallTool(plugins, invalidate);
    const result = await tool.execute!({ source: "archive", path: "C:/plugin.zip" }, { cwd: "C:/work", requestPermission });
    expect(plugins.installArchive).toHaveBeenCalledWith({
      cwd: "C:/work", archivePath: "C:/plugin.zip", expectedArchiveDigest: "digest",
      approvedPermissions: ["filesystem:workspace:read"],
    });
    expect(invalidate).toHaveBeenCalledOnce();
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("下一次对话生效") });
  });

  it.each(["denied", "expired"] as const)("does not install when permission is %s", async (status) => {
    const plugins = service();
    const tool = createPluginInstallTool(plugins, vi.fn());
    const result = await tool.execute!({ source: "archive", path: "C:/plugin.zip" }, {
      cwd: "C:/work", requestPermission: async () => ({ status }),
    });
    expect(plugins.installArchive).not.toHaveBeenCalled();
    expect(result.content[0]).toMatchObject({ text: "已取消插件安装。" });
  });

  it("fails closed without a permission host even when a user-question host exists", async () => {
    const plugins = service();
    const askUserPrompt = vi.fn(async () => "确认安装");
    const result = await createPluginInstallTool(plugins, vi.fn()).execute(
      { source: "archive", path: "C:/plugin.zip" }, { cwd: "C:/work", askUserPrompt },
    );
    expect(result.isError).toBe(true);
    expect(plugins.installArchive).not.toHaveBeenCalled();
    expect(askUserPrompt).not.toHaveBeenCalled();
  });

  it("does not install after cancellation while permission is being resolved", async () => {
    const plugins = service();
    const controller = new AbortController();
    const requestPermission = vi.fn(async (): Promise<AgentPermissionDecision> => { controller.abort(); return { status: "approved" }; });
    const result = await createPluginInstallTool(plugins, vi.fn()).execute(
      { source: "archive", path: "C:/plugin.zip" }, {
        cwd: "C:/work", runAbortSignal: controller.signal,
        requestPermission,
      },
    );
    expect(result.isError).toBe(true);
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(plugins.installArchive).not.toHaveBeenCalled();
  });

  it("pins Git installation to the preview digest", async () => {
    const plugins = service();
    const tool = createPluginInstallTool(plugins, vi.fn(async () => {}));
    await tool.execute!({ source: "git", url: "https://example.com/plugin.git", ref: "main" }, {
      cwd: "C:/work", requestPermission: async request => {
        expect(request.input).toEqual({
          source: "git", url: "https://example.com/plugin.git", ref: "main",
          preview: { identity: { id: "example.git", name: "git", version: "2.0.0" }, sourceDigest: "git-digest", commit: "abc123", requestedPermissions: [] },
        });
        return { status: "approved" };
      },
    });
    expect(plugins.installGit).toHaveBeenCalledWith({
      cwd: "C:/work", url: "https://example.com/plugin.git", ref: "main",
      expectedSourceDigest: "git-digest", approvedPermissions: [],
    });
  });

  it("reports installation success even if runtime invalidation fails", async () => {
    const plugins = service();
    const tool = createPluginInstallTool(plugins, async () => { throw new Error("refresh failed"); });
    const result = await tool.execute!({ source: "archive", path: "C:/plugin.zip" }, {
      cwd: "C:/work", requestPermission: async () => ({ status: "approved" }),
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Installed plugin 'example.test'.") });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("/reload-plugins") });
  });
});
