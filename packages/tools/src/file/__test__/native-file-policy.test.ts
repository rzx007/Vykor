import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Settings, ToolContext, ToolDefinition } from "@vykor/core";
import { createWorkspaceBinding } from "@vykor/environment";
import { createExecutionEnvironment, resolveExecutionEnvironmentConfig } from "@vykor/sandbox";
import { applyPatchTool } from "../apply-patch.js";
import { fileEditTool } from "../edit.js";
import { HostFileOperations } from "../operations.js";
import { fileReadTool } from "../read.js";
import { sandboxPathError } from "../sandbox-guard.js";
import { fileWriteTool } from "../write.js";

const secret = "private original body\n";
const secretHash = createHash("sha256").update(secret).digest("hex");

async function inNativeEnvironment(run: (context: ToolContext, files: HostFileOperations) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "oh-native-policy-"));
  const settings: Settings = { model: "fixture", apiFormat: "openai", maxTurns: 1, permission: { mode: "default" },
    sandbox: { enabled: true, filesystem: { allowRead: ["."], allowWrite: ["."], denyRead: ["secret.txt"], denyWrite: ["blocked"] } } };
  const handle = await createExecutionEnvironment({
    config: resolveExecutionEnvironmentConfig({ surface: "desktop_managed", cwd, settings }), settings,
    binding: createWorkspaceBinding({ kind: "local", hostRoot: cwd, executionRoot: cwd }), sessionId: "fixture", userSkillsRoot: cwd,
  });
  const files = new HostFileOperations();
  try {
    await writeFile(join(cwd, "secret.txt"), secret);
    await writeFile(join(cwd, "visible.txt"), "old\n");
    await run({ cwd, settings, environment: { ...handle, files } }, files);
  } finally {
    await handle.release();
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("Native environment file policy", () => {
  it("applies configuration policy after real Native path resolution", async () => {
    await inNativeEnvironment(async context => {
      expect(context.environment?.info.kind).toBe("local");
      await expect(sandboxPathError("secret.txt", context.cwd, "read", context.settings, context.environment)).resolves.toContain("Sandbox");
      await expect(sandboxPathError("blocked/new.txt", context.cwd, "write", context.settings, context.environment)).resolves.toContain("Sandbox");
      await expect(sandboxPathError("visible.txt", context.cwd, "read", context.settings, context.environment)).resolves.toBeUndefined();
    });
  });

  const readDenied: Array<[string, ToolDefinition, Record<string, unknown>]> = [
    ["Read", fileReadTool, { file_path: "secret.txt" }],
    ["Read info_only", fileReadTool, { file_path: "secret.txt", info_only: true }],
    ["Edit", fileEditTool, { file_path: "secret.txt", old_string: "wrong text", new_string: "changed" }],
    ["ApplyPatch", applyPatchTool, { patch: "--- a/secret.txt\n+++ b/secret.txt\n@@ -1 +1 @@\n-private original body\n+changed\n" }],
  ];
  it.each(readDenied)("%s refuses denied reads before file inspection or diagnostics", async (_, tool, input) => {
    await inNativeEnvironment(async (context, files) => {
      const stat = vi.spyOn(files, "stat");
      const read = vi.spyOn(files, "readBytes");
      const result = await tool.execute(input, context);
      expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
      expect(result.metadata?.fileInfo).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(secret.trim());
      expect(JSON.stringify(result)).not.toContain(secretHash);
      expect(stat).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(await readFile(join(context.cwd, "secret.txt"), "utf8")).toBe(secret);
    });
  });

  it("Write refuses a denied existing-file read without disclosing its body or hash", async () => {
    await inNativeEnvironment(async (context, files) => {
      const read = vi.spyOn(files, "readBytes");
      const result = await fileWriteTool.execute({ file_path: "secret.txt", content: "changed", overwrite: true }, context);
      expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
      expect(read).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(secret.trim());
      expect(JSON.stringify(result)).not.toContain(secretHash);
      expect(await readFile(join(context.cwd, "secret.txt"), "utf8")).toBe(secret);
    });
  });

  it("keeps new-file creation possible when writes are allowed and reads are denied", async () => {
    await inNativeEnvironment(async (context, files) => {
      const read = vi.spyOn(files, "readBytes");
      const settings: Settings = { ...context.settings!, sandbox: { enabled: true,
        filesystem: { allowRead: ["."], allowWrite: ["."], denyRead: ["new.txt"] } } };
      const result = await fileWriteTool.execute({ file_path: "new.txt", content: "new body" }, { ...context, settings });
      expect(result).toMatchObject({ executionState: "completed" });
      expect(result.isError).toBeFalsy();
      expect(read).not.toHaveBeenCalled();
      expect(await readFile(join(context.cwd, "new.txt"), "utf8")).toBe("new body");
    });
  });

  const writeDenied: Array<[string, ToolDefinition, Record<string, unknown>]> = [
    ["Write", fileWriteTool, { file_path: "blocked/new.txt", content: "new" }],
    ["Edit", fileEditTool, { file_path: "blocked/existing.txt", old_string: "old", new_string: "changed" }],
    ["ApplyPatch", applyPatchTool, { patch: "--- /dev/null\n+++ b/blocked/new.txt\n@@ -0,0 +1 @@\n+new\n" }],
  ];
  it.each(writeDenied)("%s refuses denied writes before creating files or directories", async (_, tool, input) => {
    await inNativeEnvironment(async (context, files) => {
      const stat = vi.spyOn(files, "stat");
      const result = await tool.execute(input, context);
      expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
      expect(stat).not.toHaveBeenCalled();
      expect(await readdir(context.cwd)).toEqual(expect.arrayContaining(["secret.txt", "visible.txt"]));
      expect(await readdir(context.cwd)).not.toContain("blocked");
    });
  });

  it("keeps read-only mount constraints even with configured write allowance", async () => {
    await inNativeEnvironment(async context => {
      const environment = context.environment!;
      const readonly = { ...environment, paths: { ...environment.paths,
        resolve: async (path: string, operation: "read" | "write" | "execute") => ({ ...await environment.paths.resolve(path, operation), mountMode: "ro" as const }) } };
      await expect(sandboxPathError("visible.txt", context.cwd, "write", context.settings, readonly)).resolves.toContain("read-only mount");
      await expect(sandboxPathError("visible.txt", context.cwd, "read", context.settings, readonly)).resolves.toBeUndefined();
    });
  });

  it("explicitly refuses WSL with enabled Native sandbox policy", async () => {
    await inNativeEnvironment(async context => {
      const environment = context.environment!;
      const wsl = { ...environment, info: { ...environment.info, kind: "wsl" as const } };
      await expect(sandboxPathError("visible.txt", context.cwd, "read", context.settings, wsl)).resolves.toContain("Sandbox");
    });
  });
});
