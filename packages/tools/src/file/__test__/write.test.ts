import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileWriteTool } from "../write.js";

describe("fileWriteTool feedback", () => {
  it("records a completed write without copying the file body into its summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-write-feedback-"));
    try {
      const file = join(dir, "notes.txt");
      const result = await fileWriteTool.execute({ file_path: file, content: "private body" }, { cwd: dir });
      expect(await readFile(file, "utf8")).toBe("private body");
      expect(result).toMatchObject({ executionState: "completed", compactSummary: expect.stringContaining(file) });
      expect(result.compactSummary).not.toContain("private body");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records a system path block as not started", async () => {
    const result = await fileWriteTool.execute({ file_path: "C:\\Windows\\blocked.txt", content: "private body" }, { cwd: "C:\\repo" });
    expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
  });
});
