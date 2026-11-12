import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  PROJECT_CONFIG_DIR_NAME,
  getChannelWorkspaceRoot,
  getDataRoot,
  getConfigDir,
  resolveChannelWorkspaceRoot,
  getInstalledPluginStorePath,
  getMcpOAuthFilePath,
  getMemoryDir,
  getPluginCacheDir,
  getPluginDataDir,
  getPluginSourcesDir,
  getProjectConfigDir,
  getProjectMemoryDir,
  resolvePaths,
} from "../paths.js";

it("refreshes cached data paths without relocating configuration or credentials", () => {
  const previous = process.env.VYKOR_DATA_DIR;
  try {
    delete process.env.VYKOR_DATA_DIR;
    const original = resolvePaths();
    process.env.VYKOR_DATA_DIR = resolve("/temporary/restored-data");
    const restored = resolvePaths();
    expect(restored.dataDir).toBe(process.env.VYKOR_DATA_DIR);
    expect(restored.configFilePath).toBe(original.configFilePath);
    expect(restored.credentialsFilePath).toBe(original.credentialsFilePath);
    expect(restored.logsDir).toBe(join(restored.dataDir, "logs"));
    delete process.env.VYKOR_DATA_DIR;
    expect(resolvePaths().dataDir).toBe(original.dataDir);
  } finally { if (previous === undefined) delete process.env.VYKOR_DATA_DIR; else process.env.VYKOR_DATA_DIR = previous; }
});

describe("project config directory", () => {
  it("uses .vykor as the project-level directory name", () => {
    // Use a POSIX absolute path so resolve() is stable on Linux CI and Windows.
    const root = resolve("/work/alpha");
    expect(PROJECT_CONFIG_DIR_NAME).toBe(".vykor");
    expect(getProjectConfigDir(root)).toBe(join(root, ".vykor"));
    expect(getMemoryDir(root)).toBe(join(root, ".vykor", "memory"));
  });
});

describe("getProjectMemoryDir", () => {
  it("stores project memory under data/memory with a project hash", () => {
    const a = getProjectMemoryDir(resolve("/work/alpha"));
    const b = getProjectMemoryDir(resolve("/work/beta"));

    expect(a).toContain(join("data", "memory", "alpha-"));
    expect(b).toContain(join("data", "memory", "beta-"));
    expect(a).not.toBe(b);
  });
});

describe("Native plugin paths", () => {
  it("keeps cache, data, sources and installed state under VYKOR_CONFIG_DIR", () => {
    const previous = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = resolve("/tmp/vykor-test");
    try {
      const root = join(process.env.VYKOR_CONFIG_DIR, "plugins");
      expect(getPluginCacheDir()).toBe(join(root, "cache"));
      expect(getPluginDataDir()).toBe(join(root, "data"));
      expect(getPluginSourcesDir()).toBe(join(root, "sources"));
      expect(getInstalledPluginStorePath()).toBe(join(root, "installed.json"));
    } finally {
      if (previous === undefined) delete process.env.VYKOR_CONFIG_DIR;
      else process.env.VYKOR_CONFIG_DIR = previous;
    }
  });
});

describe("MCP OAuth path", () => {
  it("stores credentials in a separate config file", () => {
    const previous = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = resolve("/tmp/vykor-oauth-test");
    try {
      expect(getMcpOAuthFilePath()).toBe(join(process.env.VYKOR_CONFIG_DIR, "mcp-oauth.json"));
    } finally {
      if (previous === undefined) delete process.env.VYKOR_CONFIG_DIR;
      else process.env.VYKOR_CONFIG_DIR = previous;
    }
  });
});

describe("resolveChannelWorkspaceRoot", () => {
  it("prefers the env override, then the outside-project root, then homedir/Documents", () => {
    const home = resolve("/tmp/vykor-home");
    expect(
      resolveChannelWorkspaceRoot({
        envDir: resolve("/tmp/vykor-channels-env"),
        outsideProjectWorkspaceRoot: resolve("/tmp/vykor-out"),
        homedir: home,
      }),
    ).toBe(resolve("/tmp/vykor-channels-env"));
    expect(
      resolveChannelWorkspaceRoot({
        outsideProjectWorkspaceRoot: resolve("/tmp/vykor-out"),
        homedir: home,
      }),
    ).toBe(join(resolve("/tmp/vykor-out"), "channels"));
    expect(resolveChannelWorkspaceRoot({ homedir: home })).toBe(
      join(home, "Documents", "Vykor", "channels"),
    );
  });
});

describe("getChannelWorkspaceRoot", () => {
  it("defaults under Documents/Vykor and honors VYKOR_CHANNELS_DIR", () => {
    const previousChannels = process.env.VYKOR_CHANNELS_DIR;
    delete process.env.VYKOR_CHANNELS_DIR;
    try {
      expect(getChannelWorkspaceRoot()).toBe(
        join(homedir(), "Documents", "Vykor", "channels"),
      );
      process.env.VYKOR_CHANNELS_DIR = resolve("/tmp/vykor-channels-workspace");
      expect(getChannelWorkspaceRoot()).toBe(resolve("/tmp/vykor-channels-workspace"));
    } finally {
      if (previousChannels === undefined) delete process.env.VYKOR_CHANNELS_DIR;
      else process.env.VYKOR_CHANNELS_DIR = previousChannels;
    }
  });
});


afterEach(() => vi.restoreAllMocks());

it("exposes one user root and all default persistent paths beneath it", () => {
  const previousRoot = process.env.VYKOR_CONFIG_DIR;
  const previousData = process.env.VYKOR_DATA_DIR;
  const root = resolve("fixtures", "用户 数据");
  process.env.VYKOR_CONFIG_DIR = root;
  delete process.env.VYKOR_DATA_DIR;
  try {
    const result = resolvePaths(resolve("project", "外部项目"));
    expect(result.dataRoot).toBe(root);
    expect(getDataRoot()).toBe(root);
    expect(getConfigDir()).toBe(root);
    expect(result).toMatchObject({
      cacheDir: join(root, "cache"),
      channelsDir: join(root, "channels"),
      workspacesDir: join(root, "workspaces"),
      worktreesDir: join(root, "worktrees"),
      desktopDataDir: join(root, "data", "desktop"),
      agentsDir: join(root, "agents"),
      localRulesDir: join(root, "local_rules", "projects"),
      outputStylesDir: join(root, "output_styles"),
      userProfilePendingDir: join(root, "user_profile_pending"),
      modelsDevCacheFilePath: join(root, "cache", "models-dev.json"),
      frecencyFilePath: join(root, "frecency.json"),
      runtimeEnvironmentSecretsFilePath: join(root, "runtime-environment-secrets.json"),
      soulFilePath: join(root, "SOUL.md"),
      userProfileFilePath: join(root, "USER.md"),
      sessionRuntimeDir: join(root, "data", "session-runtime"),
      sessionsDatabasePath: join(root, "data", "session-runtime", "sessions.db"),
      imageAttachmentCacheDir: join(root, "data", "attachments", "images"),
      daemonDir: join(root, "data", "daemon"),
      userMemoryDir: join(root, "data", "memory"),
      sessionMemoryDir: join(root, "data", "session-memory"),
      memoryBackupsDir: join(root, "data", "memory-backups"),
      exportsDir: join(root, "data", "exports"),
      backupAuditsDir: join(root, "data", "backup-audits"),
      maintenanceAuditsDir: join(root, "data", "maintenance-audits"),
      migrationsDir: join(root, "data", "migrations"),
      pathMapFilePath: join(root, "data", "migrations", "path-map.json"),
    });
    for (const [key, value] of Object.entries(result)) {
      if (key !== "memoryDir") expect(value === root || value.startsWith(root + "/") || value.startsWith(root + "\\")).toBe(true);
    }
    expect(result.memoryDir).toBe(join(resolve("project", "外部项目"), ".vykor", "memory"));
  } finally {
    if (previousRoot === undefined) delete process.env.VYKOR_CONFIG_DIR;
    else process.env.VYKOR_CONFIG_DIR = previousRoot;
    if (previousData === undefined) delete process.env.VYKOR_DATA_DIR;
    else process.env.VYKOR_DATA_DIR = previousData;
  }
});

it("recomputes project memory after cwd changes while keeping the user root", () => {
  const firstProject = resolve("projects", "first");
  const secondProject = resolve("projects", "second");
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(firstProject);
  const first = resolvePaths();
  cwd.mockReturnValue(secondProject);
  expect(getMemoryDir()).toBe(join(secondProject, ".vykor", "memory"));
  expect(resolvePaths().dataRoot).toBe(first.dataRoot);
});
