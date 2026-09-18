import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";

import {
  PROJECT_CONFIG_DIR_NAME,
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
