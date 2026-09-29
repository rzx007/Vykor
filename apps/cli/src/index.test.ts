import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ mainAction: vi.fn(async () => {}) }));

vi.mock("./commands/main", () => ({ mainAction: mocks.mainAction }));
vi.mock("./commands/auth", () => ({ createAuthCommand: () => new Command("auth") }));
vi.mock("./commands/mcp", () => ({ createMcpCommand: () => new Command("mcp") }));
vi.mock("./commands/plugin", () => ({ createPluginCommand: () => new Command("plugin") }));
vi.mock("./commands/channels", () => ({ createChannelsCommand: () => new Command("channels") }));
vi.mock("./commands/provider", () => ({ createProviderCommand: () => new Command("provider") }));
vi.mock("./commands/setup", () => ({ createSetupCommand: () => new Command("setup") }));
vi.mock("./commands/sandbox", () => ({ createSandboxCommand: () => new Command("sandbox") }));
vi.mock("./commands/workflow", () => ({ createWorkflowCommand: () => new Command("workflow") }));
vi.mock("./commands/debug", () => ({ createDebugCommand: () => new Command("debug") }));
vi.mock("./commands/daemon", () => ({
  createDaemonCommand: () => new Command("daemon"),
  createServeCommand: () => new Command("serve"),
}));
vi.mock("./config-coerce", () => ({ buildSettingsPatch: vi.fn(), coerceConfigValue: vi.fn() }));
vi.mock("./daemon-auto-start", () => ({ reconcileDaemonAutoStart: vi.fn() }));
vi.mock("./version", () => ({ VERSION: "test" }));

describe("CLI plugin options", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    mocks.mainAction.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("rejects the removed --bare option", async () => {
    process.argv = ["node", "vk", "--bare"];
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(import("./index.js")).rejects.toThrow("exit:1");
    expect(mocks.mainAction).not.toHaveBeenCalled();
  });

  it("keeps --no-plugins as the current switch", async () => {
    process.argv = ["node", "vk", "--no-plugins"];

    await import("./index.js");
    await vi.waitFor(() => expect(mocks.mainAction).toHaveBeenCalledOnce());
    expect(mocks.mainAction.mock.calls[0]?.[1]).toMatchObject({ plugins: false });
  });

  it("writes autoReview.mode through the real config set route", async () => {
    const actual = await vi.importActual<typeof import("./config-coerce")>("./config-coerce");
    const mocked = await import("./config-coerce");
    vi.mocked(mocked.coerceConfigValue).mockImplementation(actual.coerceConfigValue);
    vi.mocked(mocked.buildSettingsPatch).mockImplementation(actual.buildSettingsPatch);

    const configDir = mkdtempSync(join(tmpdir(), "vykor-cli-config-"));
    const previousConfigDir = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = configDir;

    process.argv = ["node", "vk", "config", "set", "autoReview.mode", "risk_based"];
    vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await import("./index.js");
      await vi.waitFor(() => {
        const saved = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf-8"));
        expect(saved.autoReview).toEqual({ mode: "risk_based" });
      }, { timeout: 5000 });
    } finally {
      if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
      else process.env.VYKOR_CONFIG_DIR = previousConfigDir;
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
