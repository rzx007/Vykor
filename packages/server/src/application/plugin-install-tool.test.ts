import { describe, expect, it, vi } from "vitest";
import type { PluginService } from "./settings-api.js";
import { createPluginInstallTool } from "./plugin-install-tool.js";

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
  it("previews, asks for the exact plugin permissions, installs, and invalidates runtimes", async () => {
    const plugins = service();
    const invalidate = vi.fn(async () => {});
    const ask = vi.fn(async () => "确认安装");
    const tool = createPluginInstallTool(plugins, invalidate);
    const result = await tool.execute!({ source: "archive", path: "C:/plugin.zip" }, { cwd: "C:/work", askUserPrompt: ask });
    expect(ask.mock.calls[0]![0]).toContain("filesystem:workspace:read");
    expect(plugins.installArchive).toHaveBeenCalledWith({
      cwd: "C:/work", archivePath: "C:/plugin.zip", expectedArchiveDigest: "digest",
      approvedPermissions: ["filesystem:workspace:read"],
    });
    expect(invalidate).toHaveBeenCalledOnce();
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("下一次对话生效") });
  });

  it("does not install when confirmation is missing", async () => {
    const plugins = service();
    const tool = createPluginInstallTool(plugins, vi.fn());
    const result = await tool.execute!({ source: "archive", path: "C:/plugin.zip" }, {
      cwd: "C:/work", askUserPrompt: async () => "取消",
    });
    expect(plugins.installArchive).not.toHaveBeenCalled();
    expect(result.content[0]).toMatchObject({ text: "已取消插件安装。" });
  });

  it("pins Git installation to the preview digest", async () => {
    const plugins = service();
    const tool = createPluginInstallTool(plugins, vi.fn(async () => {}));
    await tool.execute!({ source: "git", url: "https://example.com/plugin.git", ref: "main" }, {
      cwd: "C:/work", askUserPrompt: async () => "确认安装",
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
      cwd: "C:/work", askUserPrompt: async () => "确认安装",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Installed plugin 'example.test'.") });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("/reload-plugins") });
  });
});
