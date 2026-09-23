import { describe, expect, it, vi } from "vitest";

import type { ToolContext } from "@openharness/core";
import type { ExecutionEnvironmentHandle } from "@openharness/environment";
import { createWslPathResolver } from "@openharness/sandbox";

import { resolveToolPathInContext } from "../environment-path.js";
import { fileReadTool } from "../read.js";

describe("resolveToolPathInContext", () => {
  it("uses the execution environment path namespace", async () => {
    const resolve = vi.fn(async () => ({
      executionPath: "/workspace/src/app.ts",
      hostPath: "D:\\code\\ohs\\src\\app.ts",
      mountPurpose: "workspace" as const,
      mountMode: "rw" as const,
    }));
    const context = {
      cwd: "/workspace",
      environment: {
        paths: { resolve },
      } as unknown as ExecutionEnvironmentHandle,
    } satisfies ToolContext;

    await expect(
      resolveToolPathInContext("src/app.ts", context, "read"),
    ).resolves.toBe("/workspace/src/app.ts");
    expect(resolve).toHaveBeenCalledWith("src/app.ts", "read");
  });

  it("reads through the file system owned by the same environment", async () => {
    const readBytes = vi.fn(async () => new TextEncoder().encode("hello"));
    const context = {
      cwd: "/workspace",
      environment: {
        workspace: {
          kind: "wsl",
          hostRoot: "D:\\code\\ohs",
          executionRoot: "/workspace",
        },
        paths: {
          resolve: vi.fn(async (path: string) => ({
            executionPath: `/workspace/${path}`,
            hostPath: `D:\\code\\ohs\\${path}`,
            mountPurpose: "workspace" as const,
            mountMode: "rw" as const,
          })),
          toHostPath: (path: string) => path.replace("/workspace/", "D:\\code\\ohs\\"),
        },
        files: {
          stat: vi.fn(async () => ({ isFile: true, isDirectory: false })),
          readBytes,
        },
      } as unknown as ExecutionEnvironmentHandle,
    } satisfies ToolContext;

    const result = await fileReadTool.execute(
      { file_path: "src/app.ts" },
      context,
    );

    expect(readBytes).toHaveBeenCalledWith("/workspace/src/app.ts");
    expect(result.content[0]).toMatchObject({ text: "1: hello" });
  });

  it("returns a host path for images on a WSL mounted drive", async () => {
    const binding = { kind: "wsl" as const, hostRoot: "D:\\repo", executionRoot: "/mnt/d/repo" };
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const context = {
      cwd: binding.executionRoot,
      environment: {
        info: { kind: "wsl" },
        workspace: binding,
        paths: createWslPathResolver(binding),
        files: {
          stat: async () => ({ isFile: true, isDirectory: false }),
          readBytes: async () => png,
        },
      } as unknown as ExecutionEnvironmentHandle,
    } satisfies ToolContext;

    const result = await fileReadTool.execute({ file_path: "screenshot.png" }, context);

    expect(result.content[0]).toMatchObject({
      type: "image",
      source: { path: "D:\\repo\\screenshot.png", mediaType: "image/png" },
    });
  });

  it("reports WSL private images that the provider cannot open", async () => {
    const binding = { kind: "wsl" as const, hostRoot: "D:\\repo", executionRoot: "/mnt/d/repo" };
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const context = {
      cwd: binding.executionRoot,
      environment: {
        info: { kind: "wsl" },
        workspace: binding,
        paths: createWslPathResolver(binding),
        files: {
          stat: async () => ({ isFile: true, isDirectory: false }),
          readBytes: async () => png,
        },
      } as unknown as ExecutionEnvironmentHandle,
    } satisfies ToolContext;

    const result = await fileReadTool.execute({ file_path: "/home/me/screenshot.png" }, context);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not accessible to the model provider");
  });
});
