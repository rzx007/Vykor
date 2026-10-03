import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileEditTool } from "../edit.js";
import { computeFileChange } from "../preview.js";
import { HostFileOperations } from "../operations.js";

const settings = { model: "fixture", apiFormat: "openai" as const, maxTurns: 1,
  permission: { mode: "default" as const }, sandbox: { enabled: false } };
async function fixture(body: string, run: (file: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "oh-edit-batch-"));
  try { const file = join(dir, "a.txt"); await writeFile(file, body, "utf8"); await run(file, dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

describe("one file edit plan for preview, batch execution and recovery", () => {
  it("explains double-escaped line breaks without writing and accepts a corrected next call", async () => {
    const body = "before\n  /* WORK layers */\n  const track=document.querySelector('.layer-track');\n  const panSpeed=[\n    [0,'-30%',30%]\n  ];\n  document.querySelectorAll('.layer .pan').forEach((pan)=>{\nafter\n";
    const old_string = "/* WORK layers */\\n  const track=document.querySelector('.layer-track');\\n  const panSpeed=[\\n    [0,'-30%',30%]\\n  ];\\n  document.querySelectorAll('.layer .pan').forEach((pan)=>{";
    const new_string = "/* WORK layers */\\n  document.querySelectorAll('.layer .pan').forEach((pan)=>{";
    await fixture(body, async (file, dir) => {
      const failed = await fileEditTool.execute({ file_path: file, old_string, new_string }, { cwd: dir, settings });
      expect(failed).toMatchObject({ isError: true, failureKind: "precondition", executionState: "not_started",
        metadata: { editFailure: { kind: "disproportionate", matchCount: 1 } } });
      expect(failed.recoveryHint).toContain("实际换行");
      expect(failed.recoveryHint).toContain("new_string");
      expect(JSON.stringify(failed.content)).toContain("const panSpeed");
      expect(await readFile(file, "utf8")).toBe(body);
      expect(await computeFileChange("Edit", { file_path: file, old_string, new_string })).toBeNull();

      const corrected = { file_path: file,
        old_string: "/* WORK layers */\n  const track=document.querySelector('.layer-track');\n  const panSpeed=[\n    [0,'-30%',30%]\n  ];\n  document.querySelectorAll('.layer .pan').forEach((pan)=>{",
        new_string: "/* WORK layers */\n  document.querySelectorAll('.layer .pan').forEach((pan)=>{" };
      expect((await fileEditTool.execute(corrected, { cwd: dir, settings })).isError).toBeFalsy();
      expect(await readFile(file, "utf8")).toBe("before\n  /* WORK layers */\n  document.querySelectorAll('.layer .pan').forEach((pan)=>{\nafter\n");
    });
  });

  it("keeps intentional source-code escapes literal in an exact edit", async () => {
    await fixture('const pattern = "\\n";\n', async (file, dir) => {
      const input = { file_path: file, old_string: 'const pattern = "\\n";', new_string: 'const pattern = "\\t";' };
      const result = await fileEditTool.execute(input, { cwd: dir, settings });
      expect(result.isError).toBeFalsy();
      expect(await readFile(file, "utf8")).toBe('const pattern = "\\t";\n');
    });
  });

  it.each([
    ["aaaa", "aa", "bb", "bbbb"],
    ["    let x = 1;\n", "  ", "\t", "\t\tlet x = 1;\n"],
    ["\uFEFFaaaa\r\n", "aa", "$& $` $' $$", "\uFEFF$& $` $' $$$& $` $' $$\r\n"],
  ])("previews and executes exact replace_all with non-overlapping literal replacements: %j", async (body, old_string, new_string, expected) => {
    await fixture(body, async (file, dir) => {
      const input = { file_path: file, old_string, new_string, replace_all: true };
      expect((await computeFileChange("Edit", input))?.after).toBe(expected);
      expect(await readFile(file, "utf8")).toBe(body);
      const result = await fileEditTool.execute(input, { cwd: dir, settings });
      expect(result.isError).toBeFalsy();
      expect(await readFile(file, "utf8")).toBe(expected);
    });
  });

  it("previews and applies ordered dependent edits with one atomic write", async () => {
    await fixture("alpha\nbeta\n", async (file, dir) => {
      let writes = 0;
      class CountingFiles extends HostFileOperations {
        async writeTextAtomic(path: string, content: string) { writes++; await super.writeTextAtomic(path, content); }
      }
      const input = { file_path: file, edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "ALPHA\nbeta", new_string: "FIRST\nSECOND" },
      ] };
      const preview = await computeFileChange("Edit", input);
      expect(preview?.after).toBe("FIRST\nSECOND\n");
      const result = await fileEditTool.execute(input, { cwd: dir, settings, environment: {
        files: new CountingFiles(), paths: { resolve: async (path: string) => ({ executionPath: path, mountMode: "rw" }) },
      } } as never);
      expect(result.isError).toBeFalsy();
      expect(await readFile(file, "utf8")).toBe("FIRST\nSECOND\n");
      expect(writes).toBe(1);
    });
  });

  it("discards every staged change if a later edit fails and diagnoses the original file", async () => {
    await fixture("alpha\nfunction target() {\n  return 1;\n}\n", async (file, dir) => {
      const input = { file_path: file, edits: [
        { old_string: "alpha", new_string: "UNWRITTEN-FIRST-EDIT" },
        { old_string: "function target() {\n  return 999;\n}\nmissing anchor", new_string: "replacement" },
      ] };
      const result = await fileEditTool.execute(input, { cwd: dir, settings });
      expect(result).toMatchObject({ isError: true, executionState: "not_started", metadata: {
        editFailure: { editIndex: 2, source: "original_file" },
      } });
      const text = result.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      expect(text).toContain("return 1;");
      expect(text).not.toContain("UNWRITTEN-FIRST-EDIT");
      expect(await readFile(file, "utf8")).toBe("alpha\nfunction target() {\n  return 1;\n}\n");
      expect(await computeFileChange("Edit", input)).toBeNull();
    });
  });

  it("uses the same fuzzy plan for preview and execution, preserving BOM and CRLF", async () => {
    await fixture("\uFEFFfunction target() {\r\n    return 1;\r\n}\r\n", async (file, dir) => {
      const input = { file_path: file, old_string: "function target() {\n  return 1;\n}", new_string: "function target() {\n  return 2;\n}" };
      const preview = await computeFileChange("Edit", input);
      expect(preview?.after).toBe("\uFEFFfunction target() {\r\n  return 2;\r\n}\r\n");
      await fileEditTool.execute(input, { cwd: dir, settings });
      expect(await readFile(file, "utf8")).toBe(preview?.after);
    });
  });

  it("applies replacement dollar sequences literally", async () => {
    await fixture("alpha\n", async (file, dir) => {
      await fileEditTool.execute({ file_path: file, old_string: "alpha", new_string: "$& $` $' $$" }, { cwd: dir, settings });
      expect(await readFile(file, "utf8")).toBe("$& $` $' $$\n");
    });
  });

  it("returns bounded original context for ambiguous matches and does not modify the file", async () => {
    const body = Array.from({ length: 200 }, (_, i) => `same\ncontext ${i} ${"x".repeat(1000)}`).join("\n");
    await fixture(body, async (file, dir) => {
      const result = await fileEditTool.execute({ file_path: file, old_string: "same", new_string: "new" }, { cwd: dir, settings });
      expect(result.metadata?.editFailure).toMatchObject({ kind: "ambiguous", source: "original_file" });
      const windows = (result.metadata?.editFailure as { windows: unknown[] }).windows;
      expect(windows.length).toBeLessThanOrEqual(3);
      expect(result.content.map(b => b.type === "text" ? b.text : "").join("\n").length).toBeLessThanOrEqual(4096);
      expect(await readFile(file, "utf8")).toBe(body);
    });
  });

  it("rejects a stale raw-byte hash", async () => {
    await fixture("alpha\n", async (file, dir) => {
      const input = { file_path: file, old_string: "alpha", new_string: "new",
        expected_sha256: createHash("sha256").update("other").digest("hex") };
      expect(await computeFileChange("Edit", input)).toBeNull();
      const result = await fileEditTool.execute(input, { cwd: dir, settings });
      expect(result).toMatchObject({ isError: true, executionState: "not_started" });
      expect(await readFile(file, "utf8")).toBe("alpha\n");
    });
  });

  it.each([
    "--line-strong: rgba(14, 26, 546, 0.42apsed);",
    "--line-strong: rgba(14, 76, 384, 0.42apsed);",
    "--line-strong: rgba(14, 154, 767, 0.42apsed);",
  ])("locates the original declaration without applying an incorrect edit: %s", async old_string => {
    const body = Array.from({ length: 20 }, (_, i) => `/* padding ${i} */`).join("\n") + "\n    --line-strong: rgba(14, 26, 34, 0.42apsed);\n";
    await fixture(body, async (file, dir) => {
      const result = await fileEditTool.execute({ file_path: file, old_string, new_string: "--line-strong: rgba(14, 26, 34, 0.42);" }, { cwd: dir, settings });
      expect(result).toMatchObject({ isError: true, executionState: "not_started", metadata: {
        editFailure: { kind: "not_found", matchCount: 0, windows: [{ startLine: 19, endLine: 21 }] },
      } });
      expect(result.metadata?.editFailure).not.toHaveProperty("matchLines");
      expect(JSON.stringify(result.content)).toContain("21:     --line-strong: rgba(14, 26, 34, 0.42apsed);");
      expect(await readFile(file, "utf8")).toBe(body);
    });
  });

  it.each([
    ["    background-color: #123456;", "background-color: #654321;"],
    ["const timeoutMs = 100;", "const timeoutMs = 900;"],
    ['  "timeoutMs": 100,', '"timeoutMs": 900,'],
  ])("locates other stable declaration names: %s", async (original, old_string) => {
    await fixture(original + "\n", async (file, dir) => {
      const result = await fileEditTool.execute({ file_path: file, old_string, new_string: "new content" }, { cwd: dir, settings });
      expect(result.metadata?.editFailure).toMatchObject({ kind: "not_found", matchCount: 0, windows: [{ startLine: 1, endLine: 1 }] });
      expect(JSON.stringify(result.content)).toContain(original.replaceAll('"', '\\"'));
      expect(await readFile(file, "utf8")).toBe(original + "\n");
    });
  });

  it("does not mistake a similar name, comment or reference for the requested declaration", async () => {
    const body = "// const timeoutMs = 100;\nconst timeoutMsOther = 100;\nconsole.log(timeoutMs);\nconst other = timeoutMs;\n";
    await fixture(body, async (file, dir) => {
      const result = await fileEditTool.execute({ file_path: file, old_string: "const timeoutMs = 900;", new_string: "new content" }, { cwd: dir, settings });
      expect(result.metadata?.editFailure).toMatchObject({ kind: "not_found", windows: [] });
      expect(JSON.stringify(result.content)).not.toContain("console.log");
      expect(await readFile(file, "utf8")).toBe(body);
    });
  });

  it("shows the original spaced JSON id when an unspaced edit cannot match", async () => {
    const body = `{"rows":[${JSON.stringify({ padding: "x".repeat(500) })},{ "id": "th-model", "width": 100 }]}`;
    await fixture(body, async (file, dir) => {
      const input = { file_path: file, old_string: '{"id":"th-model","width":104}', new_string: "replacement" };
      const result = await fileEditTool.execute(input, { cwd: dir, settings });
      const text = result.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      expect(result.metadata?.editFailure).toMatchObject({ kind: "not_found", source: "original_file" });
      expect(text).toContain('"id": "th-model"');
      expect(text).toContain('"width": 100');
      expect(await computeFileChange("Edit", input)).toBeNull();
      expect(await readFile(file, "utf8")).toBe(body);
    });
  });

  it("shows the second JSON id after a staged batch edit fails without writing", async () => {
    const body = `{"rows":[{ "id": "th-model", "width": 100, "padding": "${"x".repeat(500)}" },{ "id": "th-product", "width": 100 }]}`;
    await fixture(body, async (file, dir) => {
      const input = { file_path: file, edits: [
        { old_string: '"width": 100, "padding"', new_string: '"width": 101, "padding"' },
        { old_string: '{"id":"th-product","width":104}', new_string: "replacement" },
      ] };
      const result = await fileEditTool.execute(input, { cwd: dir, settings });
      const text = result.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      expect(result.metadata?.editFailure).toMatchObject({ editIndex: 2, source: "original_file" });
      expect(text).toContain('"id": "th-product"');
      expect(text).toContain('"width": 100');
      expect(text).not.toContain('"width": 101');
      expect(await computeFileChange("Edit", input)).toBeNull();
      expect(await readFile(file, "utf8")).toBe(body);
    });
  });

  it.each(['中文列', 'th-\\"quoted'])("locates a raw JSON string id without changing escaped content: %s", async id => {
    const body = `{ "id": ${JSON.stringify(id)}, "width": 100 }`;
    await fixture(body, async (file, dir) => {
      const result = await fileEditTool.execute({ file_path: file,
        old_string: `{"id":${JSON.stringify(id)},"width":104}`, new_string: "replacement" }, { cwd: dir, settings });
      const text = result.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      expect(text).toContain(`"id": ${JSON.stringify(id)}`);
      expect(await readFile(file, "utf8")).toBe(body);
    });
  });

  it("suggests Read or Grep without a made-up offset when no anchor exists", async () => {
    await fixture("actual content\n", async (file, dir) => {
      const result = await fileEditTool.execute({ file_path: file, old_string: "missing content", new_string: "replacement" }, { cwd: dir, settings });
      expect(result.metadata?.editFailure).toMatchObject({ windows: [] });
      expect(result.recoveryHint).toMatch(/Read.*Grep|Grep.*Read/);
      expect(result.recoveryHint).not.toMatch(/offset=/);
    });
  });

  it("keeps declaration-location hints within the existing diagnostic bounds", async () => {
    const body = Array.from({ length: 100 }, (_, i) => `--line-strong: value-${i};\n${"x".repeat(1000)}`).join("\n");
    await fixture(body, async (file, dir) => {
      const result = await fileEditTool.execute({ file_path: file, old_string: "--line-strong: missing-value;", new_string: "new content" }, { cwd: dir, settings });
      const failure = result.metadata?.editFailure as { windows: { startLine: number; endLine: number }[] };
      expect(failure.windows.length).toBeGreaterThan(0);
      expect(failure.windows.length).toBeLessThanOrEqual(3);
      expect(failure.windows.every(w => w.endLine - w.startLine < 7)).toBe(true);
      expect(result.content.map(b => b.type === "text" ? b.text : "").join("\n").length).toBeLessThanOrEqual(4096);
      expect(await readFile(file, "utf8")).toBe(body);
    });
  });

  it("does not ask for another read when old_string and new_string are identical", async () => {
    await fixture("function messel(el) {\n}\n", async (file, dir) => {
      const result = await fileEditTool.execute({ file_path: file, old_string: "function messel(el) {", new_string: "function messel(el) {" }, { cwd: dir, settings });
      expect(result).toMatchObject({ isError: true, executionState: "not_started", metadata: { editFailure: { kind: "identical", windows: [] } } });
      expect(result.recoveryHint).not.toMatch(/Read|Grep|offset/);
      expect(result.recoveryHint).toMatch(/相同/);
      expect(await readFile(file, "utf8")).toBe("function messel(el) {\n}\n");
    });
  });

  it("does not preview a text edit that actual execution rejects as invalid UTF-8", async () => {
    await fixture("alpha\n", async (file, dir) => {
      await writeFile(file, Buffer.concat([Buffer.from("alpha\n"), Buffer.from([255])]));
      const input = { file_path: file, old_string: "alpha", new_string: "new" };
      expect(await computeFileChange("Edit", input)).toBeNull();
      expect(await fileEditTool.execute(input, { cwd: dir, settings })).toMatchObject({ isError: true, executionState: "not_started" });
    });
  });

  it.each([
    { edits: [] },
    { edits: [{ old_string: "alpha", new_string: "new" }], old_string: "alpha", new_string: "new" },
    { edits: [{ old_string: "alpha", new_string: "new", replace_all: "true" }] },
  ])("rejects invalid edit forms before accessing the filesystem: %j", async input => {
    const result = await fileEditTool.execute({ file_path: "a.txt", ...input }, { cwd: "/work", environment: {
      paths: { resolve: async () => { throw new Error("must not read files"); } },
    } } as never);
    expect(result).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
  });
});
