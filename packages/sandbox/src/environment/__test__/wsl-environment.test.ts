import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentProcessExecutor } from "@vykor/environment";
import { findPosixShell } from "../../../../../tests/helpers/posix-shell.js";

import {
  WslEnvironmentUnavailableError,
  createWslPathResolver,
  hostPathToWslPath,
  preflightWsl,
  wslPathToHostPath,
} from "../wsl-environment.js";

const shell = findPosixShell();
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("WSL environment", () => {
  it("returns actual distribution home and default shell facts", async () => {
    await expect(preflightWsl({ platform: "win32", run: async () => ({ exitCode: 0, stderr: "", homeDir: "/home/alex", shell: "/bin/zsh" }) }))
      .resolves.toEqual({ homeDir: "/home/alex", shell: "/bin/zsh" });
  });
  it("does not invent a HOME and allows an unknown user default shell", async () => {
    await expect(preflightWsl({ platform: "win32", run: async () => ({ exitCode: 0, stderr: "" }) })).rejects.toThrow(/HOME/);
    await expect(preflightWsl({ platform: "win32", run: async () => ({ exitCode: 0, stderr: "", homeDir: "/root" }) })).resolves.toEqual({ homeDir: "/root" });
  });
  it("maps Windows drive paths to WSL and back", () => {
    expect(hostPathToWslPath("D:\\Code Space\\vk")).toBe("/mnt/d/Code Space/vk");
    expect(wslPathToHostPath("/mnt/d/Code Space/vk")).toBe("D:\\Code Space\\vk");
  });

  it("resolves relative and absolute WSL paths without treating them as mounts", async () => {
    const resolver = createWslPathResolver({
      kind: "wsl",
      hostRoot: "D:\\code\\vk",
      executionRoot: "/mnt/d/code/vk",
    });

    await expect(resolver.resolve("src/index.ts", "read")).resolves.toMatchObject({
      executionPath: "/mnt/d/code/vk/src/index.ts",
      hostPath: "D:\\code\\vk\\src\\index.ts",
    });
    await expect(resolver.resolve("/home/user/file.txt", "read")).resolves.toEqual({
      executionPath: "/home/user/file.txt",
      mountPurpose: "unmounted",
    });
  });

  it("rejects WSL filesystem UNC project roots in the first release", () => {
    expect(() => hostPathToWslPath("\\\\wsl.localhost\\Ubuntu\\home\\me\\repo"))
      .toThrow("WSL filesystem projects are not supported yet");
    expect(() => hostPathToWslPath("\\\\wsl$\\Ubuntu\\home\\me\\repo"))
      .toThrow("WSL filesystem projects are not supported yet");
  });

  it("only exposes canonical paths when an execution transport is present", async () => {
    const binding = { kind: "wsl" as const, hostRoot: "D:\\workspace", executionRoot: "/mnt/d/workspace" };
    expect(createWslPathResolver(binding).canonicalize).toBeUndefined();
    let command: string[] = [];
    let receivedSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const executor: EnvironmentProcessExecutor = {
      async execShell() { throw new Error("shell must not run"); },
      async execProcess(argv, options) {
        command = argv;
        receivedSignal = options?.signal;
        return { write() {}, end() {}, onOutput(listener) { listener(Buffer.from("/mnt/d/real/invoice.png\n")); return () => {}; },
          wait: async () => ({ exitCode: 0 }), async signal() {} };
      },
    };
    const resolver = createWslPathResolver(binding, executor);
    await expect(resolver.canonicalize!("D:\\workspace\\invoice.png", controller.signal)).resolves.toBe("/mnt/d/real/invoice.png");
    expect(command).toEqual(["/usr/bin/realpath", "-e", "--", "/mnt/d/workspace/invoice.png"]);
    expect(receivedSignal).toBe(controller.signal);
  });

  it("cancels WSL canonicalization before starting and after its executor finishes", async () => {
    const controller = new AbortController();
    const resolver = createWslPathResolver({ kind: "wsl", hostRoot: "D:\\workspace", executionRoot: "/mnt/d/workspace" }, {
      async execShell() { throw new Error("shell must not run"); },
      async execProcess() {
        if (controller.signal.aborted) throw new Error("Cancelled lookup must not start");
        return { write() {}, end() {}, onOutput(listener) { listener(Buffer.from("/mnt/d/workspace\n")); return () => {}; },
          wait: async () => { controller.abort(); return { exitCode: 0 }; }, async signal() {} };
      },
    });
    await expect(resolver.canonicalize!(".", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(resolver.canonicalize!(".", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it.skipIf(!shell)("distinguishes missing WSL paths from other lookup failures using real scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-wsl-realpath-")); roots.push(root);
    await writeFile(join(root, "note"), "content", "utf8");
    const lookup = spawnSync(shell!, ["-c", 'cd -- "$1" && pwd -P', "root", root], { windowsHide: true, encoding: "utf8" });
    if (lookup.error) throw lookup.error;
    expect(lookup.status).toBe(0);
    const executionRoot = lookup.stdout.trim();
    const resolver = createWslPathResolver({ kind: "wsl", hostRoot: "D:\\workspace", executionRoot }, {
      async execShell() { throw new Error("shell transport must not run"); },
      async execProcess(argv) {
        const result = spawnSync(shell!, ["-c", 'exec "$@"', "wsl-command", ...argv], { windowsHide: true });
        if (result.error) throw result.error;
        return { write() {}, end() {}, onOutput(listener) { listener(result.stdout); return () => {}; },
          wait: async () => ({ exitCode: result.status }), async signal() {} };
      },
    });
    await expect(resolver.canonicalize!(`${executionRoot}/absent;touch nope/deep/file`)).rejects.toMatchObject({ code: "ENOENT" });
    const notDirectory = await resolver.canonicalize!(`${executionRoot}/note/deep`).catch(error => error);
    expect(notDirectory).toBeInstanceOf(Error);
    expect(notDirectory).toHaveProperty("code", "ENOTDIR");

    try { await symlink("loop", join(root, "loop"), "dir"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
    const loop = await resolver.canonicalize!(`${executionRoot}/loop/deep`).catch(error => error);
    expect(loop).toBeInstanceOf(Error);
    expect(loop).not.toHaveProperty("code", "ENOENT");
  });

  it.each([{ exitCode: 1, output: "" }, { exitCode: 0, output: "relative/path\n" }])(
    "rejects unsuccessful or invalid WSL canonical responses: %j",
    async ({ exitCode, output }) => {
      const resolver = createWslPathResolver({ kind: "wsl", hostRoot: "D:\\workspace", executionRoot: "/mnt/d/workspace" }, {
        async execShell() { throw new Error("shell must not run"); },
        async execProcess() {
          return { write() {}, end() {}, onOutput(listener) { listener(Buffer.from(output)); return () => {}; },
            wait: async () => ({ exitCode }), async signal() {} };
        },
      });
      await expect(resolver.canonicalize!("invoice.png")).rejects.toThrow();
    },
  );

  it("fails closed when WSL is unavailable", async () => {
    await expect(preflightWsl({
      platform: "win32",
      run: async () => ({ exitCode: 1, stderr: "no distribution" }),
    })).rejects.toBeInstanceOf(WslEnvironmentUnavailableError);
  });

  it("rejects WSL on non-Windows hosts without probing", async () => {
    let probed = false;
    await expect(preflightWsl({
      platform: "darwin",
      run: async () => {
        probed = true;
        return { exitCode: 0, stderr: "" };
      },
    })).rejects.toThrow("WSL is only available on Windows");
    expect(probed).toBe(false);
  });
});
