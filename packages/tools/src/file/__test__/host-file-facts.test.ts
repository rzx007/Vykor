import {executeToolFixture} from "./../../../test-helpers/tool-host-fixture.js";
import {createFileReadTool} from "./../read.js";
import {createFileWriteTool} from "./../write.js";
import {createFileEditTool} from "../editing/edit.js";
import {createApplyPatchTool} from "../editing/apply-patch.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { describe, expect, it } from "vitest";
import { fileReadTool, hostFileFacts } from "../read.js";
import { fileWriteTool } from "../write.js";
import { fileEditTool } from "../editing/edit.js";
import { applyPatchTool } from "../editing/apply-patch.js";
import { HostFileOperations } from "../operations.js";

const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
async function directory(work: (path: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), "goal-facts-"));
  try { await work(path); } finally { await rm(path, { recursive: true, force: true }); }
}
const facts = (result: { metadata?: Record<string, unknown> }) => result.metadata?.hostFileFacts as any;

describe("host file receipts", () => {
  it("uses a stable Windows path identity across casing and separator aliases", () => {
    const context = { cwd: "C:\\Work", environment: { workspace: { kind: "local", hostRoot: "C:\\Work", executionRoot: "C:\\Work" }, info: { kind: "local", pathStyle: "windows" } } } as never;
    const first = hostFileFacts(context, [{ path: "C:\\Work\\A.txt", operation: "read", afterDigest: digest("same") }]);
    const second = hostFileFacts(context, [{ path: "c:/work/a.txt", operation: "read", afterDigest: digest("same") }]);
    expect(first.files[0].subjectKey).toBe(second.files[0].subjectKey);
  });
  it("hashes the same raw bytes returned by ordinary Read without reading twice", async () => {
    await directory(async cwd => {
      const path = join(cwd, "source.txt");
      await writeFile(path, "observed\r\n", "utf8");
      let reads = 0;
      class RacingFiles extends HostFileOperations {
        override async readBytes(target: string) {
          reads += 1;
          const bytes = await super.readBytes(target);
          await writeFile(target, "later");
          return bytes;
        }
      }
      const result = await executeToolFixture(host => createFileReadTool(host), { file_path: path }, { cwd, environment: {
        workspace: { kind: "local", hostRoot: cwd, executionRoot: cwd }, files: new RacingFiles(),
        paths: { resolve: async () => ({ executionPath: path }) },
      } } as never);
      expect(reads).toBe(1);
      expect(result.content).toContainEqual({ type: "text", text: "1: observed\r\n\n(End of file - total 1 lines)" });
      expect(facts(result)?.files).toEqual([expect.objectContaining({ path, operation: "read", afterDigest: digest("observed\r\n"), completed: true, bodyVisible: true })]);
    });
  });

  it("marks info-only missing state explicitly and does not expose document body", async () => {
    await directory(async cwd => {
      const path = join(cwd, "absent.txt");
      const result = await executeToolFixture(host => createFileReadTool(host), { file_path: path, info_only: true }, { cwd });
      expect(facts(result)?.files).toEqual([expect.objectContaining({ path, operation: "read", afterDigest: "missing", bodyVisible: false })]);
    });
  });

  it("records exact create, overwrite and Edit before/after states", async () => {
    await directory(async cwd => {
      const path = join(cwd, "target.txt");
      const created = await executeToolFixture(host => createFileWriteTool(host), { file_path: path, content: "first" }, { cwd });
      const overwritten = await executeToolFixture(host => createFileWriteTool(host), { file_path: path, content: "second" }, { cwd });
      const edited = await executeToolFixture(host => createFileEditTool(host), { file_path: path, old_string: "second", new_string: "third" }, { cwd });
      expect(facts(created)?.files[0]).toMatchObject({ beforeDigest: "missing", afterDigest: digest("first"), completed: true });
      expect(facts(overwritten)?.files[0]).toMatchObject({ beforeDigest: digest("first"), afterDigest: digest("second") });
      expect(facts(edited)?.files[0]).toMatchObject({ beforeDigest: digest("second"), afterDigest: digest("third") });
      expect(facts(created)?.files[0].subjectKey).toBe(facts(edited)?.files[0].subjectKey);
      expect(await readFile(path, "utf8")).toBe("third");
    });
  });

  it("records full patch paths and missing deletion state; failed patch cannot claim completion", async () => {
    await directory(async cwd => {
      const path = join(cwd, "target.txt");
      await writeFile(path, "old\n");
      const patch = createTwoFilesPatch("target.txt", "/dev/null", "old\n", "");
      const result = await executeToolFixture(host => createApplyPatchTool(host), { patch }, { cwd });
      expect(facts(result)?.files).toEqual([expect.objectContaining({ path, beforeDigest: digest("old\n"), afterDigest: "missing", completed: true })]);
      const failed = await executeToolFixture(host => createApplyPatchTool(host), { patch }, { cwd });
      expect(failed.isError).toBe(true);
      expect(facts(failed)).toBeUndefined();
    });
  });
});
