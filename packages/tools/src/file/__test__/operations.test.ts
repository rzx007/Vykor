import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileReadTool } from "../read.js";
import { fileWriteTool } from "../write.js";
import { WslFileOperations } from "../operations.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("file operations", () => {
  it("reads and writes native workspace files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vk-files-")); roots.push(cwd);
    const file = join(cwd, "note.txt");
    await fileWriteTool.execute!({ file_path: file, content: "hello" }, { cwd });
    const readResult = await fileReadTool.execute!({ file_path: file }, { cwd });
    expect(readResult.isError).toBeFalsy();
    expect((readResult.content[0] as { text: string }).text).toBe(
      "1: hello\n\n(End of file - total 1 lines)",
    );
    expect(await readFile(file, "utf8")).toBe("hello");
  });

  it("uses the environment executor for WSL POSIX paths", async () => {
    const calls: string[][] = [];
    const operations = new WslFileOperations({
      info: { kind: "wsl" }, workspace: { executionRoot: "/mnt/d/repo" },
      process: { execProcess: async (argv: string[]) => { calls.push(argv); return environmentProcess("hello"); } },
    } as any);
    await expect(operations.readText("/home/me/file.txt")).resolves.toBe("hello");
    expect(calls[0]).toEqual(["/bin/cat", "--", "/home/me/file.txt"]);
  });
});

function environmentProcess(output: string) {
  return { write() {}, end() {}, onOutput(listener: (chunk: Uint8Array) => void) { listener(Buffer.from(output)); return () => {}; }, async wait() { return { exitCode: 0 }; }, async signal() {} };
}
