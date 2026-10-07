import { beforeEach, describe, expect, it, vi } from "vitest";
const run = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: run });
  return { ...actual, execFile };
});
vi.mock("@vykor/sandbox", async importOriginal => ({
  ...await importOriginal<typeof import("@vykor/sandbox")>(),
  preflightWsl: vi.fn(async () => ({ homeDir: "/home/test" })),
  hostPathToWslPath: () => "/mnt/d/project",
}));
vi.mock("@vykor/core", async importOriginal => ({ ...await importOriginal<typeof import("@vykor/core")>(), loadSettings: vi.fn(async () => ({ sandbox: { enabled: false } })) }));
import { checkRuntimeEnvironment, validateRuntimeEnvironmentConfig } from "./runtime-settings.js";
beforeEach(() => { run.mockReset(); run.mockImplementation(async (_file, args: string[]) => ({ stdout: args.some(arg => arg.includes("vykor-shell-ready")) ? "vykor-shell-ready" : "version" })); });
describe("real WSL shell command validation", () => {
  it("checks POSIX command execution, not unsupported sh --version", async () => {
    const report = await checkRuntimeEnvironment({ cwd: process.cwd(), config: { kind: "wsl", distribution: "Test" } });
    expect(report.find(item => item.name === "Shell")).toMatchObject({ status: "ok", detail: "/bin/sh" });
    expect(run.mock.calls.some(([, args]) => args.includes("/bin/sh") && args.includes("--version"))).toBe(false);
    expect(run.mock.calls.some(([, args]) => args.includes("--distribution") && args.includes("Test") && args.includes("-lc"))).toBe(true);
  });
  it("rejects unusable custom shell arguments before saving or importing", async () => {
    run.mockResolvedValue({ stdout: "not-the-command" });
    await expect(validateRuntimeEnvironmentConfig({ kind: "wsl", shell: { executable: "/custom/shell", args: ["--bad"] } }, undefined, false)).rejects.toThrow(/Shell/);
    expect(run.mock.calls[0]![1]).toContain("--bad");
  });
});
