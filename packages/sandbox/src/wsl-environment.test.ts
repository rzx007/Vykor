import { describe, expect, it } from "vitest";
import type { EnvironmentProcessExecutor } from "@vykor/environment";

import {
  WslEnvironmentUnavailableError,
  createWslPathResolver,
  hostPathToWslPath,
  preflightWsl,
  wslPathToHostPath,
} from "./wsl-environment.js";

describe("WSL environment", () => {
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
    const executor: EnvironmentProcessExecutor = {
      async execShell() { throw new Error("shell must not run"); },
      async execProcess(argv) {
        command = argv;
        return { write() {}, end() {}, onOutput(listener) { listener(Buffer.from("/mnt/d/real/invoice.png\n")); return () => {}; },
          wait: async () => ({ exitCode: 0 }), async signal() {} };
      },
    };
    const resolver = createWslPathResolver(binding, executor);
    await expect(resolver.canonicalize!("D:\\workspace\\invoice.png")).resolves.toBe("/mnt/d/real/invoice.png");
    expect(command).toEqual(["/usr/bin/realpath", "-e", "--", "/mnt/d/workspace/invoice.png"]);
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
