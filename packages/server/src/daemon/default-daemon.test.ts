import { describe, expect, it, vi } from "vitest";

vi.mock("@vykor/auth", () => ({ ChannelConfigStore: class {} }));
vi.mock("@vykor/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@vykor/core")>(),
  loadSettings: async () => ({ model: "fixture", agentEnvironment: { kind: "wsl" } }),
  loadProjectSettings: async () => null,
}));
vi.mock("../application/default-application-services.js", () => ({ createDefaultApplicationServices: () => ({}) }));
vi.mock("../commands/default-command-catalog.js", () => ({ createDefaultCommandCatalog: () => ({}) }));
vi.mock("../http/server.js", () => ({ startVykorServer: async (options: any) => options }));
import { startVykorDaemon } from "./default-daemon.js";

describe("daemon execution environment selection", () => {
  it("enables session execution environments by default", async () => {
    const started = await startVykorDaemon();
    expect(started.executionSurface).toBe("desktop_managed");
    expect((await started.getSettingsForCwd("D:\\repo")).agentEnvironment.kind).toBe("wsl");
  });
  it.each(["desktop_managed", "cli_advanced"] as const)("preserves explicit %s mode", async (executionSurface) => {
    const started = await startVykorDaemon({ executionSurface });
    expect(started.executionSurface).toBe(executionSurface);
  });
});
