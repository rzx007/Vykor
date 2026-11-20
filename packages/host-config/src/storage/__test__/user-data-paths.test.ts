import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as paths from "../paths.js";

afterEach(() => vi.restoreAllMocks());

describe("resolveUserDataPaths", () => {
  it("derives managed workspaces and runtime data from the same user root", () => {
    const root = resolve("fixtures", "用户 数据");
    expect(paths.resolveUserDataPaths(root)).toMatchObject({
      dataRoot: root,
      dataDir: join(root, "data"),
      cacheDir: join(root, "cache"),
      channelsDir: join(root, "channels"),
      workspacesDir: join(root, "workspaces"),
      worktreesDir: join(root, "worktrees"),
      desktopDataDir: join(root, "data", "desktop"),
    });
  });

  it("does not create directories while calculating paths", () => {
    const root = join(tmpdir(), `vykor-paths-${randomUUID()}`);
    expect(existsSync(root)).toBe(false);
    paths.resolveUserDataPaths(root);
    expect(existsSync(root)).toBe(false);
  });

  it("does not reuse paths from a different root or working directory", () => {
    const firstRoot = resolve("fixtures", "first root");
    const secondRoot = resolve("fixtures", "第二个根");
    const first = paths.resolveUserDataPaths(firstRoot);
    vi.spyOn(process, "cwd").mockReturnValue(resolve("elsewhere", "project"));
    expect(paths.resolveUserDataPaths(firstRoot)).toEqual(first);
    expect(paths.resolveUserDataPaths(secondRoot).dataDir).toBe(join(secondRoot, "data"));
  });

  it.runIf(process.platform === "win32")("preserves an explicit Windows drive and Unicode root", () => {
    const root = "D:\\用户 数据\\Vykor";
    expect(paths.resolveUserDataPaths(root).dataRoot).toBe(root);
    expect(paths.resolveUserDataPaths(root).desktopDataDir).toBe("D:\\用户 数据\\Vykor\\data\\desktop");
  });
});

it("makes the lightweight package entry available without importing settings", async () => {
  const entry = await import("@vykor/host-config/paths");
  const root = resolve("fixtures", "package root");
  expect(entry.resolveUserDataPaths(root).dataDir).toBe(join(root, "data"));
});

it("calculates complete migration paths from an explicit root without environment or project state", () => {
  const root = resolve("fixtures", "迁移目标");
  vi.stubEnv("VYKOR_CONFIG_DIR", resolve("fixtures", "other-root"));
  vi.stubEnv("VYKOR_DATA_DIR", resolve("fixtures", "legacy-data"));
  try {
    const result = paths.resolveUserDataPaths(root);
    expect(result).toMatchObject({
      sessionsDatabasePath: join(root, "data", "session-runtime", "sessions.db"),
      composerRecoveryFilePath: join(root, "data", "desktop", "composer-recovery.json"),
      credentialsFilePath: join(root, "credentials.json"),
      pluginsDir: join(root, "plugins"),
      pluginCacheDir: join(root, "plugins", "cache"),
      pluginDataDir: join(root, "plugins", "data"),
      pluginSourcesDir: join(root, "plugins", "sources"),
      installedPluginStorePath: join(root, "plugins", "installed.json"),
      notesOrganizationFilePath: join(root, "data", "session-runtime", "notes", "organization.json"),
      notesOrganizationPreviousFilePath: join(root, "data", "session-runtime", "notes", "organization.previous.json"),
      storagePolicyFilePath: join(root, "data", "session-runtime", "storage-policy.json"),
      usageSettingsFilePath: join(root, "data", "session-runtime", "usage-settings.json"),
      imageAnnotationsDir: join(root, "data", "desktop", "image-annotations"),
    });
    expect(result).not.toHaveProperty("memoryDir");
    for (const value of Object.values(result)) {
      expect(value === root || value.startsWith(root + "/") || value.startsWith(root + "\\")).toBe(true);
    }
  } finally {
    vi.unstubAllEnvs();
  }
});
