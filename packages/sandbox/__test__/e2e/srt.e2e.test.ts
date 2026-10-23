import type { ChildProcess } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { createShellProcess, getSrtAvailability } from "../../src/index.js";

const availability = getSrtAvailability({ enabled: true, failIfUnavailable: true });
const maybeDescribe = availability.available ? describe : describe.skip;

beforeAll(() => {
  if (!availability.available) console.warn(`[sandbox:e2e:srt] skipped: ${availability.reason ?? "srt is unavailable"}`);
});

maybeDescribe("srt sandbox e2e", () => {
  it("executes a shell command through SRT", async () => {
    const settings = {
      model: "test", apiFormat: "openai" as const, maxTurns: 1, permission: { mode: "default" as const },
      sandbox: { enabled: true, failIfUnavailable: true, filesystem: { allowRead: ["."], allowWrite: ["."] } },
    };
    const child = await createShellProcess("echo srt-ok", { cwd: process.cwd(), settings, stdio: ["ignore", "pipe", "pipe"] });
    const result = await collect(child);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("srt-ok");
  }, 60_000);
});

function collect(child: ChildProcess): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout }));
  });
}
