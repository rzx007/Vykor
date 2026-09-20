import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  PROJECT_CONFIG_DIR_NAME,
  getChannelWorkspaceRoot,
  resolveChannelWorkspaceRoot,
  getInstalledPluginStorePath,
  getMcpOAuthFilePath,
  getMemoryDir,
  getPluginCacheDir,
  getPluginDataDir,
  getPluginSourcesDir,
  getProjectConfigDir,
  getProjectMemoryDir,
} from "./paths";

describe("project config directory", () => {
  it("uses .openharness-ts as the project-level directory name", () => {
    // Use a POSIX absolute path so resolve() is stable on Linux CI and Windows.
    const root = resolve("/work/alpha");
    expect(PROJECT_CONFIG_DIR_NAME).toBe(".openharness-ts");
    expect(getProjectConfigDir(root)).toBe(join(root, ".openharness-ts"));
    expect(getMemoryDir(root)).toBe(join(root, ".openharness-ts", "memory"));
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
  it("keeps cache, data, sources and installed state under OPENHARNESS_CONFIG_DIR", () => {
    const previous = process.env.OPENHARNESS_CONFIG_DIR;
    process.env.OPENHARNESS_CONFIG_DIR = resolve("/tmp/openharness-test");
    try {
      const root = join(process.env.OPENHARNESS_CONFIG_DIR, "plugins");
      expect(getPluginCacheDir()).toBe(join(root, "cache"));
      expect(getPluginDataDir()).toBe(join(root, "data"));
      expect(getPluginSourcesDir()).toBe(join(root, "sources"));
      expect(getInstalledPluginStorePath()).toBe(join(root, "installed.json"));
    } finally {
      if (previous === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
      else process.env.OPENHARNESS_CONFIG_DIR = previous;
    }
  });
});

describe("MCP OAuth path", () => {
  it("stores credentials in a separate config file", () => {
    const previous = process.env.OPENHARNESS_CONFIG_DIR;
    process.env.OPENHARNESS_CONFIG_DIR = resolve("/tmp/openharness-oauth-test");
    try {
      expect(getMcpOAuthFilePath()).toBe(join(process.env.OPENHARNESS_CONFIG_DIR, "mcp-oauth.json"));
    } finally {
      if (previous === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
      else process.env.OPENHARNESS_CONFIG_DIR = previous;
    }
  });
});

describe("resolveChannelWorkspaceRoot", () => {
  it("prefers the env override, then the outside-project root, then homedir/Documents", () => {
    const home = resolve("/tmp/openharness-home");
    expect(
      resolveChannelWorkspaceRoot({
        envDir: resolve("/tmp/openharness-channels-env"),
        outsideProjectWorkspaceRoot: resolve("/tmp/openharness-out"),
        homedir: home,
      }),
    ).toBe(resolve("/tmp/openharness-channels-env"));
    expect(
      resolveChannelWorkspaceRoot({
        outsideProjectWorkspaceRoot: resolve("/tmp/openharness-out"),
        homedir: home,
      }),
    ).toBe(join(resolve("/tmp/openharness-out"), "channels"));
    expect(resolveChannelWorkspaceRoot({ homedir: home })).toBe(
      join(home, "Documents", "OpenHarness", "channels"),
    );
  });
});

describe("getChannelWorkspaceRoot", () => {
  it("defaults under Documents/OpenHarness and honors OPENHARNESS_CHANNELS_DIR", () => {
    const previousChannels = process.env.OPENHARNESS_CHANNELS_DIR;
    delete process.env.OPENHARNESS_CHANNELS_DIR;
    try {
      expect(getChannelWorkspaceRoot()).toBe(
        join(homedir(), "Documents", "OpenHarness", "channels"),
      );
      process.env.OPENHARNESS_CHANNELS_DIR = resolve("/tmp/openharness-channels-workspace");
      expect(getChannelWorkspaceRoot()).toBe(resolve("/tmp/openharness-channels-workspace"));
    } finally {
      if (previousChannels === undefined) delete process.env.OPENHARNESS_CHANNELS_DIR;
      else process.env.OPENHARNESS_CHANNELS_DIR = previousChannels;
    }
  });
});
