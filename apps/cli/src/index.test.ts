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
});
