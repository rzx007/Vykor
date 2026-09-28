import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { createTwoFilesPatch } from "diff";
import { getProjectMemoryDir, type ToolContext } from "@vykor/core";
import type { ExecutionEnvironmentHandle } from "@vykor/environment";
import { describe, expect, it } from "vitest";
import { PatchToolError, applyPatchTool, executePatchPlan, planPatch } from "../apply-patch.js";
import { FileNotFoundError } from "../operations.js";
import { fileEditTool } from "../edit.js";
import { fileWriteTool } from "../write.js";

const encoder = new TextEncoder();

class FakeFiles {
  readonly files = new Map<string, Uint8Array>();
  readonly symbolicLinks = new Set<string>();
  readonly writeCalls: string[] = [];
  readonly failWrites = new Set<string>();

  seed(path: string, content: string | Uint8Array): void {
    this.files.set(path, typeof content === "string" ? encoder.encode(content) : content);
  }

  private guard(path: string): void {
    if (this.failWrites.has(path)) throw new Error(`injected write failure: ${path}`);
  }

  async stat(path: string) {
    if (!this.files.has(path)) throw new FileNotFoundError(path);
    return { isFile: true, isDirectory: false, isSymbolicLink: this.symbolicLinks.has(path) };
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const value = this.files.get(path);
    if (!value) throw new FileNotFoundError(path);
    return value;
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }

  async listDir() {
    return [];
  }

  async writeText(path: string, content: string): Promise<void> {
    this.writeCalls.push(path);
    this.seed(path, content);
  }

  async writeBytes(path: string, content: Uint8Array): Promise<void> {
    this.writeCalls.push(path);
    this.seed(path, content);
  }

  async createTextExclusive(path: string, content: string): Promise<void> {
    if (this.files.has(path)) throw new Error(`exists: ${path}`);
    this.guard(path);
    this.writeCalls.push(path);
    this.seed(path, content);
  }

  async writeTextAtomic(path: string, content: string): Promise<void> {
    this.guard(path);
    this.writeCalls.push(path);
    this.seed(path, content);
  }

  async removeFile(path: string): Promise<void> {
    this.guard(path);
    this.writeCalls.push(path);
    this.files.delete(path);
  }

  async glob() {
    return [];
  }

  async grep() {
    return [];
  }
}

interface ContextOptions {
  style?: "windows" | "posix";
  resolve?: (path: string) => string;
}

function makeContext(files: FakeFiles, options: ContextOptions = {}): ToolContext {
  const dir = "/repo";
  const style = options.style ?? "posix";
  const environment = {
    info: { kind: style === "windows" ? "local" : "wsl", pathStyle: style },
    workspace: { executionRoot: dir, hostRoot: dir },
    files,
    paths: {
      resolve: async (path: string) => ({
        executionPath: options.resolve ? options.resolve(path) : posix.join(dir, path),
        mountPurpose: "workspace",
        mountMode: "rw",
      }),
    },
  } as unknown as ExecutionEnvironmentHandle;
  return { cwd: dir, environment } as ToolContext;
}

function updatePatch(path = "src/a.ts", from = "old", to = "new"): string {
  return `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
}

describe("planPatch", () => {
  it("plans an update without writing", async () => {
    const files = new FakeFiles();
    files.seed("/repo/src/a.ts", "old\n");
    const plan = await planPatch(updatePatch(), makeContext(files));

    expect(plan.changes).toEqual([
      expect.objectContaining({ operation: "update", relativePath: "src/a.ts", beforeHash: expect.any(String) }),
    ]);
    expect(plan.changes[0]!.newContent).toBe("new\n");
    expect(files.writeCalls).toEqual([]);
  });

  it("plans a create from /dev/null", async () => {
    const files = new FakeFiles();
    const patch = "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+created\n";
    const plan = await planPatch(patch, makeContext(files));
    expect(plan.changes[0]).toMatchObject({ operation: "create", relativePath: "src/new.ts" });
    expect(plan.changes[0]!.newContent).toBe("created\n");
    expect(files.writeCalls).toEqual([]);
  });

  it("plans a delete to /dev/null", async () => {
    const files = new FakeFiles();
    files.seed("/repo/src/gone.ts", "gone\n");
    const patch = "--- a/src/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n";
    const plan = await planPatch(patch, makeContext(files));
    expect(plan.changes[0]).toMatchObject({ operation: "delete", relativePath: "src/gone.ts" });
    expect(plan.changes[0]!.newContent).toBe("");
  });

  it("applies multiple hunks in one file", async () => {
    const files = new FakeFiles();
    files.seed("/repo/x.txt", "a\nb\nc\n");
    const patch = "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+A\n@@ -3 +3 @@\n-c\n+C\n";
    const plan = await planPatch(patch, makeContext(files));
    expect(plan.changes[0]!.newContent).toBe("A\nb\nC\n");
  });

  it("applies multiple files in one patch", async () => {
    const files = new FakeFiles();
    files.seed("/repo/a.txt", "one\n");
    files.seed("/repo/b.txt", "two\n");
    const patch =
      "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+ONE\n" +
      "--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-two\n+TWO\n";
    const plan = await planPatch(patch, makeContext(files));
    expect(plan.changes.map((change) => change.relativePath).sort()).toEqual(["a.txt", "b.txt"]);
    expect(plan.changes.map((change) => change.newContent).sort()).toEqual(["ONE\n", "TWO\n"]);
  });

  it("rejects a patch with no file sections", async () => {
    const files = new FakeFiles();
    await expect(planPatch("", makeContext(files))).rejects.toBeInstanceOf(PatchToolError);
  });

  it("rejects a file section with no hunks", async () => {
    const files = new FakeFiles();
    await expect(planPatch("--- a/x\n+++ b/x\n", makeContext(files))).rejects.toBeInstanceOf(PatchToolError);
  });

  it("rejects a rename expressed as differing old/new paths", async () => {
    const files = new FakeFiles();
    files.seed("/repo/a.ts", "old\n");
    const patch = "--- a/a.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+new\n";
    await expect(planPatch(patch, makeContext(files))).rejects.toBeInstanceOf(PatchToolError);
  });

  it("rejects duplicate identities under windows case folding", async () => {
    const files = new FakeFiles();
    files.seed("/repo/A.ts", "one\n");
    files.seed("/repo/a.ts", "two\n");
    const patch =
      "--- a/A.ts\n+++ b/A.ts\n@@ -1 +1 @@\n-one\n+ONE\n" +
      "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-two\n+TWO\n";
    await expect(planPatch(patch, makeContext(files, { style: "windows" }))).rejects.toBeInstanceOf(PatchToolError);
  });

  it("rejects creating a file that already exists", async () => {
    const files = new FakeFiles();
    files.seed("/repo/src/new.ts", "present\n");
    const patch = "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+created\n";
    await expect(planPatch(patch, makeContext(files))).rejects.toBeInstanceOf(PatchToolError);
  });

  it("rejects updating a file that does not exist", async () => {
    const files = new FakeFiles();
    await expect(planPatch(updatePatch(), makeContext(files))).rejects.toBeInstanceOf(PatchToolError);
  });

  it("rejects a symbolic link instead of replacing it", async () => {
    const files = new FakeFiles();
    files.seed("/repo/src/a.ts", "old\n");
    files.symbolicLinks.add("/repo/src/a.ts");
    await expect(planPatch(updatePatch(), makeContext(files))).rejects.toMatchObject({ kind: "invalid_input" });
    expect(files.writeCalls).toEqual([]);
  });

  it("rejects a hunk that does not match", async () => {
    const files = new FakeFiles();
    files.seed("/repo/src/a.ts", "something-else\n");
    await expect(planPatch(updatePatch(), makeContext(files))).rejects.toBeInstanceOf(PatchToolError);
  });

  it.each([
    ["GIT binary patch", "GIT binary patch\n"],
    ["Binary files", "Binary files a/x and b/x differ\n"],
    ["rename from", "rename from a/x\n"],
    ["copy from", "copy from a/x\n"],
    ["old mode", "old mode 100644\n"],
    ["new mode", "new mode 100755\n"],
    ["new file mode", "new file mode 100644\n"],
    ["deleted file mode", "deleted file mode 100644\n"],
  ])("rejects unsupported marker: %s", async (_label, marker) => {
    const files = new FakeFiles();
    await expect(planPatch(marker, makeContext(files))).rejects.toBeInstanceOf(PatchToolError);
  });

  it("rejects invalid UTF-8, NUL and control-character binary targets", async () => {
    const invalid = new FakeFiles();
    invalid.seed("/repo/src/a.ts", new Uint8Array([0xff, 0xfe, 0xfd]));
    await expect(planPatch(updatePatch(), makeContext(invalid))).rejects.toBeInstanceOf(PatchToolError);

    const nul = new FakeFiles();
    nul.seed("/repo/src/a.ts", new Uint8Array([0x6f, 0x00, 0x6c, 0x64, 0x0a]));
    await expect(planPatch(updatePatch(), makeContext(nul))).rejects.toBeInstanceOf(PatchToolError);

    const control = new FakeFiles();
    control.seed("/repo/src/a.ts", new Uint8Array(200).fill(0x01));
    await expect(planPatch(updatePatch(), makeContext(control))).rejects.toBeInstanceOf(PatchToolError);
  });

  it("rejects binary text produced by create and update hunks before writing", async () => {
    const files = new FakeFiles();
    files.seed("/repo/src/a.ts", "old\n");
    const create = "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+bad\u0000text\n";
    const update = updatePatch("src/a.ts", "old", "\u0001".repeat(200));

    await expect(planPatch(create, makeContext(files))).rejects.toMatchObject({ kind: "invalid_input" });
    await expect(planPatch(update, makeContext(files))).rejects.toMatchObject({ kind: "invalid_input" });
    expect(files.writeCalls).toEqual([]);
  });

  it("rejects a patch that would write an unpaired UTF-16 surrogate", async () => {
    const files = new FakeFiles();
    const patch = "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+bad\uD800text\n";
    await expect(planPatch(patch, makeContext(files))).rejects.toMatchObject({ kind: "invalid_input" });
    expect(files.writeCalls).toEqual([]);
  });

  it("preserves CRLF line endings", async () => {
    const files = new FakeFiles();
    files.seed("/repo/src/a.ts", "a\r\nb\r\nc\r\n");
    const patch = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
    const plan = await planPatch(patch, makeContext(files));
    expect(plan.changes[0]!.newContent).toBe("a\r\nB\r\nc\r\n");
  });

  it("preserves a UTF-8 BOM", async () => {
    const files = new FakeFiles();
    files.seed("/repo/src/a.ts", "\uFEFFtitle\nbody\n");
    const patch = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-title\n+TITLE\n body\n";
    const plan = await planPatch(patch, makeContext(files));
    expect(plan.changes[0]!.newContent).toBe("\uFEFFTITLE\nbody\n");
  });

  it("preserves the absence of a final newline", async () => {
    const files = new FakeFiles();
    files.seed("/repo/src/a.ts", "a\nb");
    const patch = createTwoFilesPatch("a/src/a.ts", "b/src/a.ts", "a\nb", "a\nB", "", "", { context: 3 });
    const plan = await planPatch(patch, makeContext(files));
    expect(plan.changes[0]!.newContent).toBe("a\nB");
  });

  it("rejects a system path resolved by the environment", async () => {
    const files = new FakeFiles();
    files.seed("/etc/passwd", "old\n");
    const context = makeContext(files, { resolve: () => "/etc/passwd" });
    const patch = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    await expect(planPatch(patch, context)).rejects.toMatchObject({ kind: "policy" });
  });

  it("rejects a managed persistence path resolved by the environment", async () => {
    const files = new FakeFiles();
    const managed = join(getProjectMemoryDir("/repo"), "entry.md");
    files.seed(managed, "old\n");
    const context = makeContext(files, { resolve: () => managed });
    const patch = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    await expect(planPatch(patch, context)).rejects.toMatchObject({ kind: "policy" });
  });
});

describe("executePatchPlan", () => {
  it("executes create, update and delete in stable path order", async () => {
    const files = new FakeFiles();
    files.seed("/repo/b.txt", "b-old\n");
    files.seed("/repo/a.txt", "a-old\n");
    files.seed("/repo/c.txt", "c-old\n");
    const patch =
      "--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-b-old\n+b-new\n" +
      "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a-old\n+a-new\n" +
      "--- a/c.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-c-old\n";
    const plan = await planPatch(patch, makeContext(files));
    const result = await executePatchPlan(plan, files as any);

    expect(result).toMatchObject({ executionState: "completed" });
    expect(files.writeCalls).toEqual(["/repo/a.txt", "/repo/b.txt", "/repo/c.txt"]);
    expect(new TextDecoder().decode(files.files.get("/repo/a.txt"))).toBe("a-new\n");
    expect(files.files.has("/repo/c.txt")).toBe(false);
  });

  it("refuses to write when a file changed after planning", async () => {
    const files = new FakeFiles();
    files.seed("/repo/src/a.ts", "old\n");
    const plan = await planPatch(updatePatch(), makeContext(files));
    files.seed("/repo/src/a.ts", "changed-by-someone-else\n");

    await expect(executePatchPlan(plan, files as any)).rejects.toBeInstanceOf(PatchToolError);
    expect(files.writeCalls).toEqual([]);
  });

  it("does not overwrite a target concurrently created after planning", async () => {
    const files = new FakeFiles();
    const patch = "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+mine\n";
    const plan = await planPatch(patch, makeContext(files));
    files.seed("/repo/src/new.ts", "theirs\n");

    const result = await executePatchPlan(plan, files as any);
    expect(result).toMatchObject({ isError: true, failureKind: "unknown_outcome", executionState: "unknown" });
    expect(new TextDecoder().decode(files.files.get("/repo/src/new.ts"))).toBe("theirs\n");
    expect(files.writeCalls).toEqual([]);
  });

  it("reports completed and pending without claiming rollback", async () => {
    const files = new FakeFiles();
    files.seed("/repo/a.txt", "a\n");
    files.seed("/repo/b.txt", "b\n");
    files.seed("/repo/c.txt", "c\n");
    const patch =
      "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+A\n" +
      "--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-b\n+B\n" +
      "--- a/c.txt\n+++ b/c.txt\n@@ -1 +1 @@\n-c\n+C\n";
    const plan = await planPatch(patch, makeContext(files));
    files.failWrites.add("/repo/b.txt");

    const result = await executePatchPlan(plan, files as any);
    expect(result).toMatchObject({ isError: true, failureKind: "unknown_outcome", executionState: "unknown" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("a.txt");
    expect(text).toContain("b.txt");
    expect(text).toContain("c.txt");
    expect(text).not.toContain("rolled back");
    expect(new TextDecoder().decode(files.files.get("/repo/a.txt"))).toBe("A\n");
    expect(new TextDecoder().decode(files.files.get("/repo/b.txt"))).toBe("b\n");
    expect(new TextDecoder().decode(files.files.get("/repo/c.txt"))).toBe("c\n");
  });

  it("keeps compactSummary bounded and free of file bodies", async () => {
    const files = new FakeFiles();
    const sections: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      const name = `dir-${String(index).padStart(3, "0")}/file-${"x".repeat(20)}-${index}.txt`;
      files.seed(`/repo/${name}`, `body-${index}\n`);
      sections.push(`--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-body-${index}\n+changed-${index}\n`);
    }
    const plan = await planPatch(sections.join(""), makeContext(files));
    const result = await executePatchPlan(plan, files as any);

    expect(result.compactSummary!.length).toBeLessThanOrEqual(1000);
    expect(result.compactSummary).toContain("more");
    expect(result.compactSummary).not.toContain("changed-");
  });
});

describe("applyPatchTool", () => {
  async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "oh-patch-"));
    try {
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const settings = (filesystem: Record<string, unknown>) => ({
    model: "m",
    apiFormat: "openai" as const,
    maxTurns: 1,
    permission: { mode: "default" as const },
    sandbox: { enabled: true, filesystem },
  });

  it("applies create, update and delete against the real filesystem", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "update.txt"), "old\n", "utf8");
      await writeFile(join(dir, "delete.txt"), "gone\n", "utf8");
      const patch =
        "--- a/update.txt\n+++ b/update.txt\n@@ -1 +1 @@\n-old\n+new\n" +
        "--- /dev/null\n+++ b/create.txt\n@@ -0,0 +1 @@\n+created\n" +
        "--- a/delete.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n";
      const result = await applyPatchTool.execute!({ patch }, { cwd: dir });

      expect(result).toMatchObject({ executionState: "completed" });
      expect(await readFile(join(dir, "update.txt"), "utf8")).toBe("new\n");
      expect(await readFile(join(dir, "create.txt"), "utf8")).toBe("created\n");
      await expect(readFile(join(dir, "delete.txt"))).rejects.toThrow();
      expect((result.content[0] as { text: string }).text).toContain("1 created, 1 updated, 1 deleted");
    });
  });

  it("rejects an invalid patch without touching the workspace", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "keep.txt"), "old\n", "utf8");
      const result = await applyPatchTool.execute!({ patch: "not a patch" }, { cwd: dir });
      expect(result).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
      expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("old\n");
    });
  });

  it("reports unsafe patch paths as invalid input before writing", async () => {
    await withDir(async (dir) => {
      const patch = updatePatch("../outside.txt");
      const result = await applyPatchTool.execute!({ patch }, { cwd: dir });
      expect(result).toMatchObject({
        isError: true,
        failureKind: "invalid_input",
        executionState: "not_started",
      });
    });
  });

  it("rejects a sandbox-denied update before writing", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "secret.txt"), "old\n", "utf8");
      const patch = "--- a/secret.txt\n+++ b/secret.txt\n@@ -1 +1 @@\n-old\n+new\n";
      const result = await applyPatchTool.execute!(
        { patch },
        { cwd: dir, settings: settings({ allowRead: ["."], denyRead: ["secret.txt"], allowWrite: ["."] }) },
      );
      expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
      expect(await readFile(join(dir, "secret.txt"), "utf8")).toBe("old\n");
    });
  });

  it("rejects a sandbox-denied create before writing", async () => {
    await withDir(async (dir) => {
      const patch = "--- /dev/null\n+++ b/blocked/new.txt\n@@ -0,0 +1 @@\n+new\n";
      const result = await applyPatchTool.execute!(
        { patch },
        { cwd: dir, settings: settings({ allowRead: ["."], denyRead: [], allowWrite: ["."], denyWrite: ["blocked"] }) },
      );
      expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
      await expect(readFile(join(dir, "blocked", "new.txt"))).rejects.toThrow();
    });
  });
});

describe("tool selection hints", () => {
  it("tells the model when to prefer ApplyPatch", () => {
    expect(applyPatchTool.description).toContain("unified diff");
    expect(applyPatchTool.description).toContain("multi-file");
    expect(fileEditTool.description).toContain("ApplyPatch");
    expect(fileWriteTool.description).toContain("overwrite");
  });
});
