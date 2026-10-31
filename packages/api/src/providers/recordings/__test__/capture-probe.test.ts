import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());
const disk = vi.hoisted(() => ({ reads: [] as string[], writes: 0 }));
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  readFile: async (path: unknown) => {
    disk.reads.push(String(path));
    const value = files.get(String(path));
    if (value === undefined) throw new Error("Unexpected fixture read");
    return value;
  },
  mkdir: async () => { disk.writes++; throw new Error("Unexpected fixture write"); },
  writeFile: async () => { disk.writes++; throw new Error("Unexpected fixture write"); },
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("manual capture probe initialization", () => {
  // Moving any setup before the safe catch must fail without reaching credentials or the network.
  it.each([
    { name: "malformed settings", route: "openai", file: "settings.json", value: "PRIVATE42", type: "SyntaxError", reads: ["settings.json"] },
    { name: "malformed credentials", route: "openai", file: "credentials.json", value: "PRIVATE42", type: "SyntaxError", reads: ["settings.json", "credentials.json"] },
    { name: "malformed Codex auth", route: "codex", file: "auth.json", value: "PRIVATE42", type: "SyntaxError", reads: ["auth.json"] },
    { name: "invalid Codex header credentials", route: "codex", file: "auth.json", value: '{"tokens":{"access_token":"PRIVATE42"}}', type: "AuthenticationFailure", reads: ["auth.json"] },
    { name: "invalid route", route: "unsupported", file: "settings.json", value: "{}", type: "Error", reads: [] },
  ])("reports only a safe error type for $name", async ({ route, file, value, type, reads }) => {
    vi.resetModules();
    const configDir = join(process.cwd(), "synthetic-probe-config");
    const codexDir = join(process.cwd(), "synthetic-probe-codex");
    vi.stubEnv("VYKOR_CONFIG_DIR", configDir);
    vi.stubEnv("CODEX_HOME", codexDir);
    files.clear();
    files.set(join(configDir, "settings.json"), "{}");
    files.set(join(configDir, "credentials.json"), "{}");
    files.set(join(codexDir, "auth.json"), "{}");
    files.set(join(file === "auth.json" ? codexDir : configDir, file), value);
    disk.reads.length = 0;
    disk.writes = 0;
    let requests = 0;
    vi.stubGlobal("fetch", () => { requests++; throw new Error("Network prohibited in probe initialization tests"); });
    const output: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { output.push(args.join(" ")); });
    vi.spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
    process.argv = ["node", "capture-probe.ts", route];
    process.exitCode = undefined;

    await expect(import("../capture-probe.js")).resolves.toBeDefined();

    expect(process.exitCode).toBe(1);
    expect(output).toEqual([JSON.stringify({ route, failed: true, type })]);
    expect(output.join("\n")).not.toContain("PRIVATE42");
    expect(disk.reads.map(path => basename(path))).toEqual(reads);
    expect(requests).toBe(0);
    expect(disk.writes).toBe(0);
  });
});
