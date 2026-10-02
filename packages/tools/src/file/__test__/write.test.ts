import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fileWriteTool } from "../write.js";
import { FileNotFoundError, HostFileOperations } from "../operations.js";

const sha256 = (value: string) =>
  createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "oh-write-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function summaryOf(result: { compactSummary?: string }): string {
  return result.compactSummary ?? "";
}

describe("fileWriteTool feedback", () => {
  it("records a completed write without copying the file body into its summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-write-feedback-"));
    try {
      const file = join(dir, "notes.txt");
      const result = await fileWriteTool.execute({ file_path: file, content: "private body" }, { cwd: dir });
      expect(await readFile(file, "utf8")).toBe("private body");
      expect(result).toMatchObject({ executionState: "completed", compactSummary: expect.stringContaining(file) });
      expect(result.compactSummary).not.toContain("private body");
      expect(summaryOf(result)).toContain("created");
      expect(summaryOf(result).length).toBeLessThanOrEqual(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records a system path block as not started", async () => {
    const result = await fileWriteTool.execute({ file_path: "C:\\Windows\\blocked.txt", content: "private body" }, { cwd: "C:\\repo" });
    expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
  });
});

describe("fileWriteTool safety", () => {
  it("keeps a concurrent new file if it appears after the last absent check", async () => {
    await withTempDir(async dir => {
      const target = join(dir, "target.txt");
      class RacingFiles extends HostFileOperations {
        async createTextExclusive(path: string, content: string) {
          await writeFile(path, "competitor");
          await super.createTextExclusive(path, content);
        }
      }
      const result = await fileWriteTool.execute({ file_path: target, content: "new" }, {
        cwd: dir,
        environment: { files: new RacingFiles(), paths: { resolve: async (path: string) => ({ executionPath: path, mountMode: "rw" }) } },
      } as never);
      expect(result.isError).toBe(true);
      expect(await readFile(target, "utf8")).toBe("competitor");
    });
  });

  it("does not overwrite bytes changed after the initial read", async () => {
    await withTempDir(async dir => {
      const file = join(dir, "a.txt");
      await writeFile(file, "old", "utf8");
      let firstRead = true;
      class ConcurrentFiles extends HostFileOperations {
        async readBytes(path: string) {
          const bytes = await super.readBytes(path);
          if (firstRead) { firstRead = false; await writeFile(path, "user's new content", "utf8"); }
          return bytes;
        }
      }
      const result = await fileWriteTool.execute({ file_path: file, content: "replacement", overwrite: true }, {
        cwd: dir,
        environment: { files: new ConcurrentFiles(), paths: { resolve: async (path: string) => ({ executionPath: path, mountMode: "rw" }) } },
      } as never);
      expect(result).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
      expect(await readFile(file, "utf8")).toBe("user's new content");
    });
  });

  it.each([
    { label: "missing content", input: { file_path: "value.txt" } },
    { label: "unresolved reference", input: { file_path: "value.txt", content_from: "source" } },
    { label: "content plus reference", input: { file_path: "value.txt", content: "body", content_from: "source" } },
    { label: "legacy prepare", input: { action: "prepare", file_path: "value.txt", content: "body" } },
    { label: "legacy prepared reference", input: { file_path: "value.txt", content: "body", prepared_from: "source" } },
    { label: "legacy expected absence", input: { file_path: "value.txt", content: "body", expected_absent: true } },
    { label: "unknown field", input: { file_path: "value.txt", content: "body", surprise: true } },
  ])("rejects $label before resolving a path", async ({ input }) => {
    const context = { cwd: "/work", environment: { paths: {
      resolve: async () => { throw new Error("must not access filesystem"); },
    } } } as never;
    const result = await fileWriteTool.execute(input, context);
    expect(result).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
  });

  it("creates an empty file when complete content is an empty string", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "empty.txt");
      const result = await fileWriteTool.execute({ file_path: file, content: "" }, { cwd: dir });
      expect(result).toMatchObject({ executionState: "completed" });
      expect(await readFile(file, "utf8")).toBe("");
    });
  });

  it("creates a file when the environment's filesystem comes from another module instance", async () => {
    await withTempDir(async (dir) => {
      vi.resetModules();
      const duplicate = await import("../operations.js");
      expect(duplicate.FileNotFoundError).not.toBe(FileNotFoundError);
      const file = join(dir, "new.txt");
      const result = await fileWriteTool.execute({ file_path: file, content: "created across modules" }, {
        cwd: dir,
        environment: {
          files: new duplicate.HostFileOperations(),
          paths: { resolve: async (path: string) => ({ executionPath: resolve(dir, path), mountMode: "rw" }) },
        },
      } as any);
      expect(result).toMatchObject({ executionState: "completed" });
      expect(await readFile(file, "utf8")).toBe("created across modules");
    });
  });

  it("does not treat permission errors as permission to create a missing file", async () => {
    await withTempDir(async (dir) => {
      class DeniedFiles extends HostFileOperations {
        async stat(): Promise<never> { throw Object.assign(new Error("denied"), { code: "EACCES" }); }
      }
      const file = join(dir, "denied.txt");
      const result = await fileWriteTool.execute({ file_path: file, content: "must not write" }, {
        cwd: dir,
        environment: {
          files: new DeniedFiles(),
          paths: { resolve: async (path: string) => ({ executionPath: resolve(dir, path), mountMode: "rw" }) },
        },
      } as any);
      expect(result.isError).toBe(true);
      await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("creates a new file with parent directories", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "nested", "deep", "new.txt");
      const result = await fileWriteTool.execute({ file_path: file, content: "fresh" }, { cwd: dir });
      expect(result).toMatchObject({ executionState: "completed" });
      expect(await readFile(file, "utf8")).toBe("fresh");
      expect((result.content[0] as { text: string }).text).toContain("Created");
    });
  });

  it("refuses to overwrite an existing different file by default", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "value.txt");
      await writeFile(file, "old", "utf8");
      const result = await fileWriteTool.execute({ file_path: file, content: "new" }, { cwd: dir });
      expect(result).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
      expect(await readFile(file, "utf8")).toBe("old");
    });
  });

  it("overwrites only when overwrite is true", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "value.txt");
      await writeFile(file, "old", "utf8");
      const result = await fileWriteTool.execute({ file_path: file, content: "new", overwrite: true }, { cwd: dir });
      expect(result).toMatchObject({ executionState: "completed" });
      expect((result.content[0] as { text: string }).text).toContain("Overwrote");
      expect(await readFile(file, "utf8")).toBe("new");
    });
  });

  it("returns unchanged without writing identical bytes", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "same.txt");
      await writeFile(file, "same", "utf8");
      const before = await stat(file);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = await fileWriteTool.execute({ file_path: file, content: "same" }, { cwd: dir });
      const after = await stat(file);
      expect((result.content[0] as { text: string }).text).toContain("No write needed");
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(summaryOf(result)).toContain("unchanged");
    });
  });

  it("accepts a matching expected_sha256 when overwriting", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "value.txt");
      await writeFile(file, "old", "utf8");
      const result = await fileWriteTool.execute(
        { file_path: file, content: "new", overwrite: true, expected_sha256: sha256("old") },
        { cwd: dir },
      );
      expect(result).toMatchObject({ executionState: "completed" });
      expect(await readFile(file, "utf8")).toBe("new");
    });
  });

  it("rejects a mismatched expected_sha256 without writing", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "value.txt");
      await writeFile(file, "old", "utf8");
      const result = await fileWriteTool.execute(
        { file_path: file, content: "new", overwrite: true, expected_sha256: sha256("other") },
        { cwd: dir },
      );
      expect(result).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
      expect(await readFile(file, "utf8")).toBe("old");
    });
  });

  it("rejects an invalid expected_sha256 before touching the target", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a-directory");
      await mkdir(target);
      const result = await fileWriteTool.execute(
        { file_path: target, content: "new", expected_sha256: "not-a-hash" },
        { cwd: dir },
      );
      expect(result).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
      expect((result.content[0] as { text: string }).text).toContain("expected_sha256");
    });
  });

  it("rejects an invalid hash before resolving the path", async () => {
    let resolves = 0;
    const context = {
      cwd: "/workspace",
      environment: {
        paths: {
          resolve: async () => {
            resolves += 1;
            throw new Error("path resolution should not run");
          },
        },
      },
    } as never;
    const result = await fileWriteTool.execute(
      { file_path: "value.txt", content: "new", expected_sha256: "invalid" },
      context,
    );
    expect(result).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
    expect(resolves).toBe(0);
  });

  it("does not compare a valid hash when the content is unchanged", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "same.txt");
      await writeFile(file, "same", "utf8");
      const result = await fileWriteTool.execute(
        { file_path: file, content: "same", expected_sha256: sha256("something-else") },
        { cwd: dir },
      );
      expect(result).toMatchObject({ executionState: "completed" });
      expect((result.content[0] as { text: string }).text).toContain("No write needed");
    });
  });

  it("refuses expected_sha256 when creating a new file", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "brand-new.txt");
      const result = await fileWriteTool.execute(
        { file_path: file, content: "new", expected_sha256: sha256("") },
        { cwd: dir },
      );
      expect(result).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
      await expect(readFile(file)).rejects.toThrow();
    });
  });

  it("declines to write over a non-file path", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a-directory");
      await mkdir(target);
      const result = await fileWriteTool.execute({ file_path: target, content: "new" }, { cwd: dir });
      expect(result).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
      expect((result.content[0] as { text: string }).text).toContain("non-file");
    });
  });

  it("declines to replace a symbolic link", async () => {
    await withTempDir(async (dir) => {
      const real = join(dir, "real.txt");
      const link = join(dir, "link.txt");
      await writeFile(real, "original", "utf8");
      try {
        await symlink(real, link, "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }
      const result = await fileWriteTool.execute(
        { file_path: link, content: "replacement", overwrite: true },
        { cwd: dir },
      );
      expect(result).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
      expect(await readFile(real, "utf8")).toBe("original");
    });
  });

  it("keeps sandbox write policy for writes outside the boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-write-sandbox-"));
    const outside = await mkdtemp(join(tmpdir(), "oh-write-outside-"));
    try {
      const file = join(outside, "secret.txt");
      const result = await fileWriteTool.execute(
        { file_path: file, content: "secret" },
        {
          cwd: dir,
          settings: {
            model: "m",
            apiFormat: "openai",
            maxTurns: 1,
            permission: { mode: "default" },
            sandbox: { enabled: true },
          },
        },
      );
      expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
      await expect(readFile(file)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not read an existing file when sandbox read access is denied", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "secret.txt");
      await writeFile(file, "secret", "utf8");
      const result = await fileWriteTool.execute(
        { file_path: file, content: "secret", overwrite: true },
        {
          cwd: dir,
          settings: {
            model: "m",
            apiFormat: "openai",
            maxTurns: 1,
            permission: { mode: "default" },
            sandbox: {
              enabled: true,
              filesystem: { allowRead: ["."], denyRead: ["secret.txt"], allowWrite: ["."] },
            },
          },
        },
      );
      expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
      expect(result.compactSummary).toBeUndefined();
      expect(await readFile(file, "utf8")).toBe("secret");
    });
  });

  it("keeps the summary within 1000 characters and free of the file body", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "summary.txt");
      const result = await fileWriteTool.execute(
        { file_path: file, content: "SENSITIVE-CONTENT-MARKER" },
        { cwd: dir },
      );
      expect(summaryOf(result).length).toBeLessThanOrEqual(1000);
      expect(summaryOf(result)).not.toContain("SENSITIVE-CONTENT-MARKER");
      expect(summaryOf(result)).toContain("sha256");
    });
  });
});
