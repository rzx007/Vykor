import { createHash } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolContext, ToolResult } from "@vykor/agent-contracts";
import type { EnvironmentReadBytesOptions } from "@vykor/environment";
import { describe, expect, it } from "vitest";
import { executeToolFixture } from "../../../test-helpers/tool-host-fixture.js";
import { HostFileOperations } from "../operations.js";
import { createFileReadTool } from "../read.js";

const MiB = 1024 * 1024;
const text = (result: ToolResult) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");

class CountedFiles extends HostFileOperations {
  bytesRead = 0;
  override async readBytes(path: string, options?: EnvironmentReadBytesOptions) {
    const bytes = await super.readBytes(path, options);
    this.bytesRead += bytes.byteLength;
    return bytes;
  }
}

async function fixture(run: (path: string, files: CountedFiles, context: ToolContext) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "oh-read-budget-"));
  const files = new CountedFiles();
  const context = { cwd, environment: {
    workspace: { hostRoot: cwd, executionRoot: cwd }, files,
    paths: { resolve: async (path: string) => ({ executionPath: path, mountMode: "rw" }), toHostPath: (path: string) => path },
  } } as unknown as ToolContext;
  try { await run(join(cwd, "data.txt"), files, context); }
  finally {
    const target = resolve(cwd), child = relative(resolve(tmpdir()), target);
    if (!child || child.startsWith("..") || isAbsolute(child) || !target.includes("oh-read-budget-")) throw new Error("Unsafe temporary cleanup");
    await rm(target, { recursive: true, force: true });
  }
}

const read = (path: string, context: ToolContext, extra: Record<string, unknown> = {}) => executeToolFixture(createFileReadTool, { file_path: path, ...extra }, context);

describe("Read input byte budgets", () => {
  // Removing maxBytes would consume the entire 16 MiB file despite limit=1.
  it("bounds actual bytes for limit=1 and omits a full-file receipt for a prefix", async () => fixture(async (path, files, context) => {
    // Valid text ensures binary detection cannot mask an unbounded read.
    await writeFile(path, "first\n" + "x\n".repeat(8 * MiB));
    const result = await read(path, context, { limit: 1 });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("1: first");
    expect(files.bytesRead).toBeLessThanOrEqual(MiB + 1);
    expect(text(result)).toMatch(/total.*unknown|unknown.*total/i);
    expect(result.metadata?.hostFileFacts).toBeUndefined();
  }));

  it("returns a bounded, explicitly incomplete fragment for a multi-megabyte single line", async () => fixture(async (path, files, context) => {
    await writeFile(path, "a".repeat(3 * MiB));
    const result = await read(path, context, { limit: 1 });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("line truncated to 2000 chars");
    expect(text(result)).toMatch(/incomplete line|line.*incomplete/i);
    expect(text(result)).not.toContain("End of file");
    expect(files.bytesRead).toBeLessThanOrEqual(MiB + 1);
    expect(result.metadata?.hostFileFacts).toBeUndefined();
  }));

  it("rejects an offset beyond the scanned prefix without claiming it is past EOF", async () => fixture(async (path, files, context) => {
    await writeFile(path, "row\n".repeat(MiB));
    const result = await read(path, context, { offset: 999999999 });
    expect(result).toMatchObject({ isError: true, failureKind: "precondition", executionState: "completed" });
    expect(text(result)).toMatch(/scan.*budget|input.*budget/i);
    expect(text(result)).not.toContain("out of range");
    expect(files.bytesRead).toBeLessThanOrEqual(MiB + 1);
  }));

  it("refuses oversized info_only before reading or emitting a prefix hash", async () => fixture(async (path, files, context) => {
    const handle = await open(path, "w");
    try { await handle.truncate(16 * MiB); } finally { await handle.close(); }
    const result = await read(path, context, { info_only: true });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/hash.*limit|hash.*budget/i);
    expect(files.bytesRead).toBe(0);
    expect(result.metadata?.hostFileFacts).toBeUndefined();
    expect(result.metadata?.fileInfo).toBeUndefined();
  }));

  it("checks image size before ingesting its bytes", async () => fixture(async (path, files, context) => {
    const image = path.replace(/txt$/, "png");
    const handle = await open(image, "w");
    try { await handle.write(Buffer.from([137,80,78,71,13,10,26,10])); await handle.truncate(24 * MiB); } finally { await handle.close(); }
    const result = await read(image, context);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/image.*limit|image.*budget/i);
    expect(files.bytesRead).toBe(0);
  }));

  it("hashes all bytes of a complete info snapshot, including non-text bytes", async () => fixture(async (path, files, context) => {
    const bytes = Buffer.from([0xff, 0, 0xe4, 0xb8, 0xad]);
    await writeFile(path, bytes);
    const result = await read(path, context, { info_only: true });
    expect(result.isError).toBeFalsy();
    expect(result.metadata?.fileInfo).toMatchObject({ sizeBytes: 5, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(files.bytesRead).toBe(5);
  }));

  it("does not treat a UTF-8 sequence split by the input cap as invalid bytes", async () => fixture(async (path, files, context) => {
    await writeFile(path, "a".repeat(MiB - 1) + "中more");
    const result = await read(path, context, { limit: 1 });
    expect(result.isError).toBeFalsy();
    expect(text(result)).not.toContain("�");
    expect(files.bytesRead).toBeLessThanOrEqual(MiB + 1);
  }));

  it("rejects malformed UTF-8 inside the scanned bytes", async () => fixture(async (path, _files, context) => {
    await writeFile(path, Buffer.from([0x61, 0xc3, 0x28, 0x0a]));
    const result = await read(path, context);
    expect(result).toMatchObject({ isError: true, failureKind: "precondition" });
    expect(text(result)).toContain("Cannot read binary file");
  }));

  it("reports cancellation during stat as interrupted without further reading", async () => fixture(async (path, files, context) => {
    await writeFile(path, "text");
    const controller = new AbortController();
    const stat = files.stat.bind(files);
    files.stat = async (target, signal) => { controller.abort(); return stat(target, signal); };
    const result = await read(path, { ...context, abortSignal: controller.signal });
    expect(result).toMatchObject({ isError: true, failureKind: "interrupted", executionState: "completed" });
    expect(files.bytesRead).toBe(0);
    expect(result.metadata?.hostFileFacts).toBeUndefined();
  }));

  it("passes cancellation into byte I/O and discards a cancelled result", async () => fixture(async (path, files, context) => {
    await writeFile(path, "text");
    const controller = new AbortController();
    const readBytes = files.readBytes.bind(files);
    files.readBytes = async (target, options) => {
      expect(options?.signal).toBe(controller.signal);
      const bytes = await readBytes(target, options);
      controller.abort();
      return bytes;
    };
    const result = await read(path, { ...context, abortSignal: controller.signal });
    expect(result).toMatchObject({ isError: true, failureKind: "interrupted", executionState: "completed" });
    expect(result.metadata?.hostFileFacts).toBeUndefined();
  }));

  it("still bounds an info hash when the file grows after stat", async () => fixture(async (path, files, context) => {
    await writeFile(path, "short");
    const stat = files.stat.bind(files);
    files.stat = async (target, signal) => {
      const item = await stat(target, signal);
      await writeFile(target, "x".repeat(9 * MiB));
      return item;
    };
    const result = await read(path, context, { info_only: true });
    expect(result.isError).toBe(true);
    expect(files.bytesRead).toBe(8 * MiB + 1);
    expect(result.metadata?.fileInfo).toBeUndefined();
    expect(result.metadata?.hostFileFacts).toBeUndefined();
  }));

  it("bounds text even when an injected backend has no size metadata", async () => fixture(async (path, files, context) => {
    await writeFile(path, "x\n".repeat(2 * MiB));
    const stat = files.stat.bind(files);
    files.stat = async (target, signal) => ({ ...await stat(target, signal), sizeBytes: undefined });
    const result = await read(path, context, { limit: 1 });
    expect(result.isError).toBeFalsy();
    expect(files.bytesRead).toBe(MiB + 1);
    expect(result.metadata?.hostFileFacts).toBeUndefined();
  }));

  it("keeps an exact-budget full file eligible for a full-byte receipt", async () => fixture(async (path, files, context) => {
    const bytes = Buffer.alloc(MiB, 0x61);
    await writeFile(path, bytes);
    const result = await read(path, context, { limit: 1 });
    expect(result.isError).toBeFalsy();
    expect(files.bytesRead).toBe(MiB);
    expect(text(result)).toContain("End of file - total 1 lines");
    expect(result.metadata?.hostFileFacts).toMatchObject({ files: [{ afterDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }] });
  }));

  it("allows continuing to an already scanned incomplete final line", async () => fixture(async (path, _files, context) => {
    await writeFile(path, "x\n".repeat(MiB / 2 - 1) + "last line extends beyond budget");
    const result = await read(path, context, { offset: MiB / 2 - 1, limit: 1 });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Use offset=524288 to continue within the scanned prefix.");
    const finalLine = await read(path, context, { offset: MiB / 2, limit: 1 });
    expect(text(finalLine)).toContain("524288: la");
    expect(text(finalLine)).toContain("Last shown line is incomplete.");
    expect(text(finalLine)).not.toContain("offset=524289");
  }));

  it("bounds a known image even if it grows after the size check", async () => fixture(async (path, files, context) => {
    const image = path.replace(/txt$/, "png");
    const signature = Buffer.from([137,80,78,71,13,10,26,10]);
    await writeFile(image, signature);
    const stat = files.stat.bind(files);
    files.stat = async (target, signal) => {
      const item = await stat(target, signal);
      const handle = await open(target, "r+");
      try { await handle.truncate(24 * MiB); } finally { await handle.close(); }
      return item;
    };
    const result = await read(image, context);
    expect(result.isError).toBe(true);
    expect(files.bytesRead).toBe(20 * MiB + 1);
    expect(text(result)).toMatch(/image.*limit/i);
  }));

  it("preserves extensionless images larger than the text scan budget with a bounded media read", async () => fixture(async (path, files, context) => {
    const bytes = Buffer.alloc(2 * MiB, 0x61);
    bytes.set([137,80,78,71,13,10,26,10]);
    await writeFile(path, bytes);
    const result = await read(path, context);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "image", source: { type: "file", mediaType: "image/png", path, sizeBytes: 2 * MiB } }]);
    expect(files.bytesRead).toBe(3 * MiB + 1);
  }));
});
