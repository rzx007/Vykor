import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileReadTool } from "../read.js";

const settings = { model: "fixture", apiFormat: "openai" as const, maxTurns: 1,
  permission: { mode: "default" as const }, sandbox: { enabled: false } };

async function inDirectory(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "oh-file-info-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("Read info_only before generating file changes", () => {
  it("reports existing raw bytes and hash without returning the body or changing the file", async () => {
    await inDirectory(async dir => {
      const file = join(dir, "a.txt");
      await writeFile(file, "private body", "utf8");
      const result = await fileReadTool.execute({ file_path: file, info_only: true }, { cwd: dir, settings });
      expect(result.metadata?.fileInfo).toMatchObject({ path: file, exists: true, kind: "file", sizeBytes: 12,
        sha256: createHash("sha256").update("private body").digest("hex"), parentExists: true });
      expect(result.isError).toBeFalsy();
      const text = result.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      expect(JSON.parse(text)).toMatchObject({ exists: true, kind: "file" });
      expect(text).not.toContain("private body");
      expect(await readFile(file, "utf8")).toBe("private body");
    });
  });

  it("reports a missing target and missing parent without creating either", async () => {
    await inDirectory(async dir => {
      const file = join(dir, "missing", "new.txt");
      const result = await fileReadTool.execute({ file_path: file, info_only: true }, { cwd: dir, settings });
      expect(result.metadata?.fileInfo).toMatchObject({ exists: false, kind: "missing", parentExists: false });
      expect(result).toMatchObject({ executionState: "completed" });
      await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("describes a directory as a directory rather than a writable text target", async () => {
    await inDirectory(async dir => {
      const target = join(dir, "folder");
      await mkdir(target);
      const result = await fileReadTool.execute({ file_path: target, info_only: true }, { cwd: dir, settings });
      expect(result.metadata?.fileInfo).toMatchObject({ exists: true, kind: "directory" });
      expect(result.metadata?.fileInfo).not.toHaveProperty("sha256");
    });
  });

  it("does not expose info when target read policy denies access", async () => {
    await inDirectory(async dir => {
      const file = join(dir, "secret.txt");
      await writeFile(file, "secret", "utf8");
      const result = await fileReadTool.execute({ file_path: file, info_only: true }, { cwd: dir, settings: {
        ...settings, sandbox: { enabled: true, filesystem: { allowRead: ["."], denyRead: ["secret.txt"], allowWrite: ["."] } },
      } });
      expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
      expect(result.metadata?.fileInfo).toBeUndefined();
    });
  });

  it("reports write-policy restrictions without treating a read as authorization", async () => {
    await inDirectory(async dir => {
      const file = join(dir, "a.txt");
      await writeFile(file, "old", "utf8");
      const result = await fileReadTool.execute({ file_path: file, info_only: true }, { cwd: dir, settings: {
        ...settings, sandbox: { enabled: true, filesystem: { allowRead: ["."], allowWrite: ["."], denyWrite: ["a.txt"] } },
      } });
      expect(result.metadata?.fileInfo).toMatchObject({ exists: true, kind: "file", writePolicyError: expect.any(String) });
      expect(await readFile(file, "utf8")).toBe("old");
    });
  });

  it("recognizes a dangling symlink instead of suggesting that its path can be created", async () => {
    await inDirectory(async dir => {
      const link = join(dir, "link.txt");
      try { await symlink(join(dir, "absent.txt"), link, "file"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
      const result = await fileReadTool.execute({ file_path: link, info_only: true }, { cwd: dir, settings });
      expect(result.metadata?.fileInfo).toMatchObject({ exists: true, kind: "symlink" });
      expect(result.metadata?.fileInfo).not.toHaveProperty("sha256");
    });
  });
});
