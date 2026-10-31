import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolContext, ToolResult } from "@vykor/agent-contracts";
import { describe, expect, it } from "vitest";
import { executeToolFixture as runToolFixture } from "../../../test-helpers/tool-host-fixture.js";
import { createFileReadTool } from "../read.js";
import { createFileWriteTool } from "../write.js";
import { createFileEditTool } from "../editing/edit.js";
import { createApplyPatchTool } from "../editing/apply-patch.js";
import { HostFileOperations } from "../operations.js";
import type { EnvironmentReadBytesOptions } from "@vykor/environment";

const text = (result: ToolResult) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
const deliveries = new WeakMap<ToolContext, { seen: Set<string>; pending: Set<string> }>();

async function executeToolFixture(...args: Parameters<typeof runToolFixture>) {
  const result = await runToolFixture(...args);
  const state = deliveries.get(args[2]);
  if (state) {
    for (const key of result.metadata?.hostProjectInstructionKeys as string[] ?? []) state.seen.add(key);
    state.pending.clear(); // The next call represents the next model batch, with only delivered keys visible.
  }
  return result;
}

async function fixture(run: (root: string, context: ToolContext, seen: Set<string>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "oh-scoped-rules-"));
  const seen = new Set<string>();
  const pending = new Set<string>();
  const context = { cwd: root, projectInstructions: {
    claim: (key: string) => seen.has(key) ? "visible" : pending.has(key) ? "pending" : (pending.add(key), "new"),
    canRead: async () => true,
  } } as unknown as ToolContext;
  deliveries.set(context, { seen, pending });
  try {
    await mkdir(join(root, "nested"));
    await mkdir(join(root, "unrelated"));
    await writeFile(join(root, "nested", "AGENTS.md"), "NESTED_RULE_ALPHA");
    await writeFile(join(root, "unrelated", "AGENTS.md"), "UNRELATED_SECRET_RULE");
    await writeFile(join(root, "nested", "data.txt"), "old\n");
    await run(root, context, seen);
  } finally {
    const target = resolve(root), child = relative(resolve(tmpdir()), target);
    if (!child || child.startsWith("..") || isAbsolute(child) || !target.includes("oh-scoped-rules-")) throw new Error("Unsafe fixture cleanup");
    await rm(target, { recursive: true, force: true });
  }
}

const read = (path: string, context: ToolContext) => executeToolFixture(createFileReadTool, { file_path: path }, context);

describe("target-scoped project instructions", () => {
  // Omitting target-time discovery loses a child scope when the run starts at its parent.
  it("loads only the target ancestor scope when reading from the workspace root", async () => fixture(async (root, context) => {
    const result = await read(join(root, "nested", "data.txt"), context);
    expect(text(result)).toContain("NESTED_RULE_ALPHA");
    expect(text(result)).not.toContain("UNRELATED_SECRET_RULE");
    expect(text(result)).toContain(JSON.stringify(join(root, "nested")));
    expect(text(result)).toMatch(/user instructions.*precedence/i);
  }));

  it("deduplicates parallel reads, reloads changed content, and replays after history eviction", async () => fixture(async (root, context, seen) => {
    const target = join(root, "nested", "data.txt");
    const pair = await Promise.all([read(target, context), read(target, context)]);
    expect(pair.filter(result => text(result).includes("NESTED_RULE_ALPHA"))).toHaveLength(1);
    await writeFile(join(root, "nested", "AGENTS.md"), "NESTED_RULE_BETA");
    expect(text(await read(target, context))).toContain("NESTED_RULE_BETA");
    expect(text(await read(target, context))).not.toContain("NESTED_RULE_BETA");
    seen.clear();
    expect(text(await read(target, context))).toContain("NESTED_RULE_BETA");
  }));

  it.each([
    ["Write", createFileWriteTool, { file_path: "nested/data.txt", content: "new\n" }],
    ["Edit", createFileEditTool, { file_path: "nested/data.txt", old_string: "old", new_string: "new" }],
    ["ApplyPatch", createApplyPatchTool, { patch: "--- a/nested/data.txt\n+++ b/nested/data.txt\n@@ -1 +1 @@\n-old\n+new\n" }],
  ] as const)("surfaces newly discovered rules before %s mutates the target", async (_name, factory, input) => fixture(async (root, context) => {
    const first = await executeToolFixture(factory, input, context);
    expect(first).toMatchObject({ isError: true, executionState: "not_started", failureKind: "precondition" });
    expect(text(first)).toContain("NESTED_RULE_ALPHA");
    expect(await readFile(join(root, "nested", "data.txt"), "utf8")).toBe("old\n");
    expect((await executeToolFixture(factory, input, context)).isError).toBeFalsy();
    expect(await readFile(join(root, "nested", "data.txt"), "utf8")).toBe("new\n");
  }));

  it("does not load a denied instruction file", async () => fixture(async (root, context) => {
    (context as unknown as { projectInstructions: { canRead: (path: string) => Promise<boolean> } }).projectInstructions.canRead = async path => !path.endsWith("AGENTS.md");
    expect(text(await read(join(root, "nested", "data.txt"), context))).not.toContain("NESTED_RULE_ALPHA");
  }));

  it("does not discover instructions across the workspace boundary or a directory link", async () => fixture(async (root, context) => {
    context.cwd = join(root, "nested");
    await writeFile(join(root, "unrelated", "data.txt"), "outside body");
    await symlink(join(root, "unrelated"), join(root, "nested", "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(text(await read(join(root, "unrelated", "data.txt"), context))).not.toContain("UNRELATED_SECRET_RULE");
    expect(text(await read(join(root, "nested", "linked", "data.txt"), context))).not.toContain("UNRELATED_SECRET_RULE");
  }));

  // A directory alias must not hide the real target's parent rules.
  it("loads real ancestor rules through an in-workspace directory alias", async () => fixture(async (root, context) => {
    await mkdir(join(root, "package", "sub"), { recursive: true });
    await writeFile(join(root, "package", "AGENTS.md"), "REAL_PACKAGE_RULE");
    await writeFile(join(root, "package", "sub", "data.txt"), "body");
    await symlink(join(root, "package", "sub"), join(root, "nested", "linked"), process.platform === "win32" ? "junction" : "dir");
    const result = await read(join(root, "nested", "linked", "data.txt"), context);
    expect(text(result)).toContain("REAL_PACKAGE_RULE");
    expect(text(result)).not.toContain("NESTED_RULE_ALPHA");
  }));

  // Missing child directories still inherit rules from the nearest real parent.
  it("blocks creating a missing target through an alias until real ancestor rules are delivered", async () => fixture(async (root, context) => {
    await mkdir(join(root, "package", "sub"), { recursive: true });
    await writeFile(join(root, "package", "AGENTS.md"), "REAL_CREATE_RULE");
    await symlink(join(root, "package", "sub"), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const input = { file_path: "linked/future/deep/data.txt", content: "new\n" };
    const first = await executeToolFixture(createFileWriteTool, input, context);
    expect(first).toMatchObject({ isError: true, executionState: "not_started", failureKind: "precondition" });
    expect(text(first)).toContain("REAL_CREATE_RULE");
    await expect(readFile(join(root, "package", "sub", "future", "deep", "data.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await executeToolFixture(createFileWriteTool, input, context)).isError).toBeFalsy();
    expect(await readFile(join(root, "package", "sub", "future", "deep", "data.txt"), "utf8")).toBe("new\n");
  }));

  it("uses the WSL execution filesystem for rules rather than reading the host workspace", async () => fixture(async (root, context) => {
    const executionFiles = join(root, "execution");
    await mkdir(join(executionFiles, "nested"), { recursive: true });
    await writeFile(join(executionFiles, "nested", "data.txt"), "wsl body");
    await writeFile(join(executionFiles, "nested", "CLAUDE.md"), "WSL_EXECUTION_RULE");
    const toHost = (path: string) => join(executionFiles, path.slice("/work".length));
    const toExecution = (path: string) => "/work/" + relative(executionFiles, path).replaceAll("\\", "/");
    class ExecutionFiles extends HostFileOperations {
      override stat(path: string, signal?: AbortSignal) { return super.stat(toHost(path), signal); }
      override readBytes(path: string, options?: EnvironmentReadBytesOptions) { return super.readBytes(toHost(path), options); }
      override async openRead(path: string, signal?: AbortSignal) {
        const reader = await super.openRead(toHost(path), signal);
        return { ...reader, canonicalPath: toExecution(reader.canonicalPath) };
      }
    }
    context.environment = { info: { kind: "wsl", pathStyle: "posix" },
      workspace: { kind: "wsl", hostRoot: root, executionRoot: "/work" }, files: new ExecutionFiles(),
      paths: { resolve: async (path: string) => ({ executionPath: path, mountMode: "rw" }),
        canonicalize: async (path: string) => toExecution(await realpath(toHost(path))) },
    } as unknown as ToolContext["environment"];
    const result = await read("/work/nested/data.txt", context);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("WSL_EXECUTION_RULE");
    expect(text(result)).toContain("wsl body");
    expect(text(result)).not.toContain("NESTED_RULE_ALPHA");
  }));

  it("keeps a mutation blocked while an earlier parallel read has only claimed the rule", async () => fixture(async (root, context) => {
    const claimed = new Set<string>();
    context.projectInstructions!.claim = key => claimed.has(key) ? "pending" : (claimed.add(key), "new");
    expect(text(await read(join(root, "nested", "data.txt"), context))).toContain("NESTED_RULE_ALPHA");
    const result = await executeToolFixture(createFileWriteTool, { file_path: "nested/data.txt", content: "new\n" }, context);
    expect(result).toMatchObject({ isError: true, executionState: "not_started" });
    expect(await readFile(join(root, "nested", "data.txt"), "utf8")).toBe("old\n");
  }));

  // A prefix must never certify unseen tail instructions as a fully delivered rule version.
  it("delivers the tail of a rule larger than 12 KB before allowing mutation", async () => fixture(async (root, context) => {
    await writeFile(join(root, "nested", "AGENTS.md"), "r".repeat(90_000) + "REQUIRED_TAIL_RULE");
    let delivered = "", succeeded = false;
    for (let round = 0; round < 8; round++) {
      const result = await executeToolFixture(createFileWriteTool, { file_path: "nested/data.txt", content: "new\n" }, context);
      if (!result.isError) {
        expect(delivered).toContain("REQUIRED_TAIL_RULE");
        succeeded = true;
        break;
      }
      delivered += text(result);
      expect(await readFile(join(root, "nested", "data.txt"), "utf8")).toBe("old\n");
    }
    expect(succeeded).toBe(true);
  }));

  // Previously visible ancestors must not consume each later batch's new-instruction allowance.
  it("progressively delivers five ancestor rule files and eventually permits the single target", async () => fixture(async (root, context) => {
    let directory = root;
    for (let level = 0; level < 5; level++) {
      directory = join(directory, `level-${level}`);
      await mkdir(directory);
      await writeFile(join(directory, "AGENTS.md"), `RULE_LEVEL_${level}\n` + "r".repeat(11_900));
    }
    const target = join(directory, "data.txt");
    await writeFile(target, "old\n");
    let delivered = "", succeeded = false;
    for (let round = 0; round < 5; round++) {
      const result = await executeToolFixture(createFileWriteTool, { file_path: target, content: "new\n" }, context);
      if (!result.isError) { succeeded = true; break; }
      delivered += text(result);
      expect(await readFile(target, "utf8")).toBe("old\n");
    }
    expect(delivered).toContain("RULE_LEVEL_4");
    expect(succeeded).toBe(true);
  }));

  it("keeps an oversized rule blocked without accepting any partial version", async () => fixture(async (root, context) => {
    await writeFile(join(root, "nested", "AGENTS.md"), "r".repeat(1024 * 1024 + 10));
    for (let round = 0; round < 2; round++) {
      const result = await executeToolFixture(createFileWriteTool, { file_path: "nested/data.txt", content: "new\n" }, context);
      expect(result).toMatchObject({ isError: true, executionState: "not_started" });
      expect(result.metadata?.hostProjectInstructionKeys).toEqual([]);
      expect(text(result)).toContain("exceeds the 1 MiB automatic read limit");
      expect(await readFile(join(root, "nested", "data.txt"), "utf8")).toBe("old\n");
    }
  }));
});
