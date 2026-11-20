import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWslPathResolver } from "@vykor/sandbox";
import type { ToolContext } from "@vykor/agent-contracts";
import { resolveToolPathInContext } from "../environment-path.js";
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("relocates a native managed history path before selecting the execution namespace", async () => {
  const root = mkdtempSync(join(tmpdir(), "tool-history-")); roots.push(root);
  const old = join(root, "old"), current = join(root, "current"), workspace = join(current, "workspaces/chat"), outside = join(root, "outside");
  mkdirSync(join(current, "data/migrations"), { recursive: true }); mkdirSync(workspace, { recursive: true }); mkdirSync(outside);
  writeFileSync(join(current, "data/migrations/path-map.json"), JSON.stringify({ version: 1, moves: [{ kind: "workspace", from: old, to: workspace }] }));
  vi.stubEnv("VYKOR_CONFIG_DIR", current);
  expect(await resolveToolPathInContext(join(old, "read.txt"), { cwd: workspace }, "read")).toBe(join(workspace, "read.txt"));
  symlinkSync(outside, join(workspace, "escape"), "junction");
  await expect(resolveToolPathInContext(join(old, "escape/file.txt"), { cwd: workspace }, "read")).rejects.toThrow(/escape|scope/i);
  if (process.platform === "win32") {
    const executionRoot = "/mnt/" + workspace[0]!.toLowerCase() + workspace.slice(2).replaceAll("\\", "/");
    const paths = createWslPathResolver({ kind: "wsl", hostRoot: workspace, executionRoot });
    const context = { cwd: executionRoot, environment: { paths } } as ToolContext;
    expect(await resolveToolPathInContext(join(old, "read.txt"), context, "read")).toBe(executionRoot + "/read.txt");
    expect(await resolveToolPathInContext("/home/user/image.png", context, "read")).toBe("/home/user/image.png");
  }
});
