import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { loadSettings, saveProjectSettings, saveSettings } from "../settings.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
describe("loadSettings", () => {
  let savedConfigDir: string | undefined;

  beforeEach(async () => {
    savedConfigDir = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = await fs.mkdtemp(
      path.join(os.tmpdir(), "oh-settings-test-"),
    );
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
    else process.env.VYKOR_CONFIG_DIR = savedConfigDir;
  });

  it("returns default settings with no overrides", async () => {
    const settings = await loadSettings();
    expect(typeof settings.model).toBe("string");
    expect(settings.model.length).toBeGreaterThan(0);
    expect(["anthropic", "openai", "openai_compat"]).toContain(settings.apiFormat);
    expect(settings.permission.mode).toBe("default");
    expect(settings.maxTurns).toBe(0);
    expect(settings.sandbox).toMatchObject({
      enabled: false,
      failIfUnavailable: false,
      filesystem: { allowRead: ["."], allowWrite: ["."] },
      network: { mode: "none" },
    });
  });

  it("applies cli overrides", async () => {
    const settings = await loadSettings({ model: "gpt-4o", maxTurns: 10 });
    expect(settings.model).toBe("gpt-4o");
    expect(settings.maxTurns).toBe(10);
  });

  it("uses VYKOR_CONFIG_DIR for settings.json", async () => {
    const saved = process.env.VYKOR_CONFIG_DIR;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oh-settings-"));
    const configDir = path.join(tempDir, "config");
    try {
      process.env.VYKOR_CONFIG_DIR = configDir;
      await saveSettings({
        model: "deepseek-chat",
        apiFormat: "openai",
        provider: "deepseek",
        maxTurns: 12,
        permission: { mode: "default" },
      });

      const raw = await fs.readFile(path.join(configDir, "settings.json"), "utf-8");
      expect(JSON.parse(raw).provider).toBe("deepseek");

      const loaded = await loadSettings();
      expect(loaded.provider).toBe("deepseek");
    } finally {
      if (saved === undefined) delete process.env.VYKOR_CONFIG_DIR;
      else process.env.VYKOR_CONFIG_DIR = saved;
    }
  });

  it("deep merges SRT sandbox file settings with defaults", async () => {
    const configDir = process.env.VYKOR_CONFIG_DIR!;
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, "settings.json"), JSON.stringify({
      sandbox: { enabled: true, network: { mode: "none" }, srt: { runtimeCommand: "custom-srt" } },
    }));
    expect((await loadSettings()).sandbox).toMatchObject({
      enabled: true,
      srt: { runtimeCommand: "custom-srt" },
      filesystem: { allowRead: ["."], allowWrite: ["."] },
    });
  });

  it("applies the agent environment override", async () => {
    const saved = process.env.VYKOR_AGENT_ENVIRONMENT;
    try {
      process.env.VYKOR_AGENT_ENVIRONMENT = "wsl";
      expect((await loadSettings()).agentEnvironment).toEqual({ kind: "wsl" });
    } finally {
      if (saved === undefined) delete process.env.VYKOR_AGENT_ENVIRONMENT;
      else process.env.VYKOR_AGENT_ENVIRONMENT = saved;
    }
  });

  it("ANTHROPIC_BASE_URL does not pollute the generic baseUrl", async () => {
    const savedA = process.env.ANTHROPIC_BASE_URL;
    const savedO = process.env.VYKOR_BASE_URL;
    try {
      // 用户为 Claude Code 设的 ANTHROPIC_BASE_URL 不该灌进通用 baseUrl
      // （否则 deepseek 等非 Anthropic provider 的请求会被发到 anthropic 端点）。
      process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
      delete process.env.VYKOR_BASE_URL;
      const s1 = await loadSettings();
      expect(s1.baseUrl).not.toBe("https://api.anthropic.com");

      // 通用覆盖仍走 VYKOR_BASE_URL。
      process.env.VYKOR_BASE_URL = "https://my.proxy/v1";
      const s2 = await loadSettings();
      expect(s2.baseUrl).toBe("https://my.proxy/v1");
    } finally {
      if (savedA === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = savedA;
      if (savedO === undefined) delete process.env.VYKOR_BASE_URL;
      else process.env.VYKOR_BASE_URL = savedO;
    }
  });
});
