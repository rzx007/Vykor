import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  argv: [] as string[], child: null as any, probeScript: "", probeOutput: "/home/alex\n/bin/zsh\n",
}));
vi.mock("node:child_process", async (original) => {
  const runProbe = async (bin: string, args: string[]) => {
    if (bin !== "wsl.exe" || args[0] !== "--exec" || args[1] !== "/bin/sh") throw new Error("Wrong WSL probe transport");
    transport.probeScript = args[3]!;
    return { stdout: transport.probeOutput, stderr: "" };
  };
  return {
  ...await original<typeof import("node:child_process")>(),
  spawn: (bin: string, args: string[]) => {
    if (bin !== "wsl.exe") throw new Error(`Unexpected transport: ${bin}`);
    transport.argv = args;
    transport.child = new EventEmitter();
    return transport.child;
  },
  execFile: Object.assign(() => { throw new Error("Use the real execFile promisify contract"); }, {
    [Symbol.for("nodejs.util.promisify.custom")]: runProbe,
  }),
}; });
import { preflightWsl, spawnWslProcess, wslPathToHostPath } from "./wsl-environment.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/sh.exe" : "/bin/sh";

describe("WSL process boundary without a WSL distribution", () => {
  it("decodes the default probe's HOME and SHELL response", async () => {
    await expect(preflightWsl({ platform: "win32" })).resolves.toEqual({ homeDir: "/home/alex", shell: "/bin/zsh" });
  });

  it.skipIf(!existsSync(shell))("executes the probe with exported HOME and user SHELL intact", async () => {
    await preflightWsl({ platform: "win32" });
    const result = spawnSync(shell, ["-c", `HOME=/home/alex; SHELL=/usr/bin/fish; ${transport.probeScript}`], { encoding: "utf8", timeout: 3000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("/home/alex\n/usr/bin/fish\n");
  });

  it.skipIf(process.platform !== "win32")("creates and cleans up the cancellation marker without spawning WSL", () => {
    const controller = new AbortController();
    const child = spawnWslProcess({ argv: ["printf", "ok"], cwd: "/mnt/d/repo/sub", signal: controller.signal, env: { VK_VALUE: "safe value" } });
    const marker = wslPathToHostPath(transport.argv[7]!)!;
    try {
      expect(existsSync(marker)).toBe(false);
      controller.abort();
      expect(readFileSync(marker, "utf8")).toBe("cancel");
      expect(transport.argv.slice(-4)).toEqual(["/usr/bin/env", "VK_VALUE=safe value", "printf", "ok"]);
    } finally { child.emit("close", 143); }
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(!existsSync(shell))("executes the probe to recover the account HOME when HOME and SHELL are not exported", async () => {
    await preflightWsl({ platform: "win32" });
    const harness = `unset HOME SHELL
getent() { printf 'alex:x:1000:1000::/accounts/alex:/bin/zsh\\n'; }
id() { printf '1000\\n'; }
${transport.probeScript}`;
    const result = spawnSync(shell, ["-c", harness], { encoding: "utf8", timeout: 3000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("/accounts/alex\n\n");
  });

  it.skipIf(!existsSync(shell))("executes the cancellation supervisor through an external process-group kill", () => {
    const root = mkdtempSync(join(tmpdir(), "vk-wsl-cancel-boundary-")); roots.push(root);
    const marker = join(root, "cancel").replaceAll("\\", "/");
    const log = join(root, "kill.log").replaceAll("\\", "/");
    writeFileSync(marker, "cancel");
    const controller = new AbortController();
    const originalTmpdir = process.env.TMPDIR;
    try {
      if (process.platform !== "win32") process.env.TMPDIR = "C:/Temp";
      spawnWslProcess({ argv: ["echo", "ok"], cwd: "/mnt/d/repo/sub", signal: controller.signal });
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    }
    expect(transport.argv[7]).toMatch(/^\/mnt\/[a-z]\/.+\/vykor-wsl-cancel-/i);
    expect(transport.argv.slice(0, 5)).toEqual(["--cd", "/mnt/d/repo/sub", "--exec", "/bin/sh", "-c"]);
    // The transport commands are replaced with deterministic boundary doubles.
    // A shell builtin rejects the group flags; the external kill accepts them.
    const script = transport.argv[5]!.replaceAll("/usr/bin/setsid", "fake_setsid").replaceAll("/bin/kill", "external_kill");
    const harness = `fake_setsid() { :; }
kill() { case "$1" in -0) return 0;; *) return 2;; esac; }
external_kill() { printf '<%s>' "$@" >> "$termination_log"; }
${script}`;
    const result = spawnSync(shell, ["-c", harness, "vk-supervisor", marker, "echo", "ok"], {
      encoding: "utf8", env: { ...process.env, termination_log: log }, timeout: 3000,
    });
    transport.child.emit("close", 143);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(143);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toMatch(/^<-TERM><--><-\d+>$/);
  });
});
