import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_READ_BYTES,
  fileReadTool,
  isBinaryContent,
  missingPathMessage,
  normalizeReadInteger,
  readPathInfo,
  readTrailer,
  sliceDirectoryEntries,
  sliceReadLines,
  splitReadLines,
  suggestSimilarNames,
  truncateReadLine,
} from "../read.js";

describe("fileReadTool", () => {
  it("does not advertise the daemon attachment protocol", () => {
    expect(fileReadTool.description).not.toContain("attachment://");
    const schema = fileReadTool.inputSchema as {
      properties: { file_path: { description: string } };
    };
    expect(schema.properties.file_path.description).not.toContain("attachment://");
  });

  it("treats attachment URIs as invalid local paths", async () => {
    const result = await fileReadTool.execute!(
      { file_path: "attachment://att_123/report.log" },
      { cwd: "D:/project" },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Error reading file");
  });

  it("reads files with line numbers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-"));
    try {
      const file = join(dir, "notes.txt");
      await writeFile(file, "one\ntwo\nthree", "utf-8");

      const result = await fileReadTool.execute!(
        { file_path: file, offset: 2, limit: 1 },
        { cwd: dir }
      );

      expect((result.content[0] as any).text).toBe(
        "2: two\n\n(Showing lines 2-2 of 3. Use offset=3 to continue.)",
      );
      expect(result.isError).toBeFalsy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns a PNG as an image block", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-image-"));
    try {
      const file = join(dir, "screenshot.png");
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
      await writeFile(file, png);

      const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{
        type: "image",
        source: { type: "file", mediaType: "image/png", path: file, sizeBytes: png.byteLength },
      }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a mislabeled image instead of returning its bytes as text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-image-"));
    try {
      const file = join(dir, "broken.png");
      await writeFile(file, "not a PNG");

      const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("Invalid image file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unrecognized binary data rather than showing replacement characters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-binary-"));
    try {
      const file = join(dir, "data.bin");
      await writeFile(file, Buffer.from([0, 255, 1, 2]));

      const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toBe(
        `Cannot read binary file: ${file}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists directory entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-dir-"));
    try {
      await mkdir(join(dir, "app"));
      await writeFile(join(dir, "README.md"), "hello", "utf-8");

      const result = await fileReadTool.execute!(
        { file_path: dir },
        { cwd: dir }
      );

      const text = (result.content[0] as any).text as string;
      expect(text).toContain("app/");
      expect(text).toContain("README.md");
      expect(result.isError).toBeFalsy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects paths outside cwd when sandbox is enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-sandbox-"));
    const outside = await mkdtemp(join(tmpdir(), "oh-read-outside-"));
    try {
      const file = join(outside, "secret.txt");
      await writeFile(file, "secret", "utf-8");

      const result = await fileReadTool.execute!(
        { file_path: file },
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

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("outside the sandbox boundary");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("appends an end-of-file trailer when the whole file is read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-eof-"));
    try {
      const file = join(dir, "three.txt");
      await writeFile(file, "one\ntwo\nthree", "utf-8");

      const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("1: one");
      expect(text).toContain("(End of file - total 3 lines)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports end-of-file when limit exactly exhausts the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-exact-"));
    try {
      const file = join(dir, "three.txt");
      await writeFile(file, "one\ntwo\nthree", "utf-8");

      const result = await fileReadTool.execute!({ file_path: file, offset: 1, limit: 3 }, { cwd: dir });

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("(End of file - total 3 lines)");
      expect(text).not.toContain("Use offset=");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not count a trailing newline as an extra line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-trailing-"));
    try {
      const file = join(dir, "two.txt");
      await writeFile(file, "a\nb\n", "utf-8");

      const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

      expect((result.content[0] as { text: string }).text).toContain("(End of file - total 2 lines)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caps output at the byte budget and keeps the trailer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-bytes-"));
    try {
      const file = join(dir, "big.txt");
      const lines = Array.from({ length: 30 }, () => "a".repeat(1990));
      await writeFile(file, lines.join("\n"), "utf-8");

      const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Output capped at 50 KB");
      expect(text).toContain("Use offset=");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("truncates a line beyond 2000 characters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-longline-"));
    try {
      const file = join(dir, "long.txt");
      await writeFile(file, "x".repeat(2500), "utf-8");

      const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

      expect((result.content[0] as { text: string }).text).toContain("(line truncated to 2000 chars)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a file containing NUL without returning its content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-nul-"));
    try {
      const file = join(dir, "bin.dat");
      await writeFile(file, Buffer.from([0x68, 0x00, 0x69]), "binary");

      const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toBe(`Cannot read binary file: ${file}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a file dominated by control characters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-control-"));
    try {
      const file = join(dir, "ctrl.dat");
      await writeFile(file, Buffer.from(new Array(200).fill(0x01)), "binary");

      const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("Cannot read binary file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not misclassify normal text with tabs and CJK as binary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-text-"));
    try {
      const file = join(dir, "normal.txt");
      await writeFile(file, "col1\tcol2\n中文 🙂\n", "utf-8");

      const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { text: string }).text).toContain("col1\tcol2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports an out-of-range offset with the total line count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-range-"));
    try {
      const file = join(dir, "three.txt");
      await writeFile(file, "one\ntwo\nthree", "utf-8");

      const result = await fileReadTool.execute!({ file_path: file, offset: 5 }, { cwd: dir });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toBe(
        "Offset 5 is out of range for this file (3 lines)",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads an empty file with a zero-line trailer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-empty-"));
    try {
      const file = join(dir, "empty.txt");
      await writeFile(file, "", "utf-8");

      const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { text: string }).text).toBe("(End of file - total 0 lines)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("normalizes invalid offset and limit instead of failing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-normalize-"));
    try {
      const file = join(dir, "three.txt");
      await writeFile(file, "one\ntwo\nthree", "utf-8");

      const result = await fileReadTool.execute!({ file_path: file, offset: -5, limit: 0 }, { cwd: dir });

      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      expect(text.startsWith("1: one")).toBe(true);
      expect(text).toContain("(Showing lines 1-1 of 3. Use offset=2 to continue.)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back from non-finite offset and limit values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-nonfinite-"));
    try {
      const file = join(dir, "two.txt");
      await writeFile(file, "one\ntwo", "utf-8");

      const result = await fileReadTool.execute!(
        { file_path: file, offset: Number.NaN, limit: Number.POSITIVE_INFINITY },
        { cwd: dir },
      );

      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("1: one");
      expect(text).toContain("2: two");
      expect(text).not.toMatch(/NaN|Infinity/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("advertises offset-based continuation in its description", () => {
    expect(fileReadTool.description).toContain("offset");
    expect(fileReadTool.description).toContain("image");
    expect(fileReadTool.description).toContain("50 KB");
  });

  it("appends an entry count for a non-empty directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-dircount-"));
    try {
      await mkdir(join(dir, "app"));
      await writeFile(join(dir, "README.md"), "hello", "utf-8");

      const result = await fileReadTool.execute!({ file_path: dir }, { cwd: dir });

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("app/");
      expect(text).toContain("(2 entries)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports truncation for a directory listing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-dirturnc-"));
    try {
      for (const name of ["a.txt", "b.txt", "c.txt"]) {
        await writeFile(join(dir, name), "x", "utf-8");
      }

      const result = await fileReadTool.execute!({ file_path: dir, limit: 2 }, { cwd: dir });

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Showing entries 1-2 of 3. Use offset=3 to continue.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports the shown range when a directory page reaches the end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-dirend-"));
    try {
      for (const name of ["a.txt", "b.txt", "c.txt"]) {
        await writeFile(join(dir, name), "x", "utf-8");
      }

      const result = await fileReadTool.execute!({ file_path: dir, offset: 2 }, { cwd: dir });

      expect((result.content[0] as { text: string }).text).toContain(
        "Showing entries 2-3 of 3. End of directory.",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caps a large directory listing by bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-dirbytes-"));
    try {
      const names = Array.from(
        { length: 360 },
        (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(140)}.txt`,
      );
      for (const name of names) {
        await writeFile(join(dir, name), "x", "utf-8");
      }

      const result = await fileReadTool.execute!({ file_path: dir }, { cwd: dir });

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Output capped at 50 KB");
      expect(text).toContain("Use offset=");
      expect(Buffer.byteLength(text.split("\n\n")[0]!, "utf8")).toBeLessThanOrEqual(MAX_READ_BYTES);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports an out-of-range directory offset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-dirrange-"));
    try {
      await writeFile(join(dir, "a.txt"), "x", "utf-8");
      await writeFile(join(dir, "b.txt"), "x", "utf-8");

      const result = await fileReadTool.execute!({ file_path: dir, offset: 5 }, { cwd: dir });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toBe(
        "Offset 5 is out of range for this directory (2 entries)",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the empty-directory message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-dirempty-"));
    try {
      const result = await fileReadTool.execute!({ file_path: dir }, { cwd: dir });
      expect((result.content[0] as { text: string }).text).toBe("(empty directory)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("suggests similar names when the path is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-suggest-"));
    try {
      await writeFile(join(dir, "config.ts"), "x", "utf-8");

      // 目标名 "config" 是已存在条目 "config.ts" 的前缀，满足"互相包含"。
      const result = await fileReadTool.execute!({ file_path: join(dir, "config") }, { cwd: dir });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("File not found:");
      expect(text).toContain("Did you mean one of these?");
      expect(text).toContain("config.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not list sibling suggestions when sandbox access excludes the parent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-suggest-sandbox-"));
    try {
      await writeFile(join(dir, "secret.txt"), "x", "utf-8");
      const result = await fileReadTool.execute!(
        { file_path: join(dir, "secret") },
        {
          cwd: dir,
          settings: {
            model: "m",
            apiFormat: "openai",
            maxTurns: 1,
            permission: { mode: "default" },
            sandbox: {
              enabled: true,
              filesystem: { allowRead: ["secret"], allowWrite: [] },
            },
          },
        },
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Error reading file:");
      expect(text).not.toContain("Did you mean");
      expect(text).not.toContain("secret.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a plain not-found error when nothing is similar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-nosuggest-"));
    try {
      const result = await fileReadTool.execute!({ file_path: join(dir, "zzz.ts") }, { cwd: dir });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toBe(`File not found: ${join(dir, "zzz.ts")}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves the stat error when the parent still lists the exact name", () => {
    const file = join("root", "secret.txt");
    const text = missingPathMessage(file, ["secret.txt"], new Error("denied"));
    expect(text).toContain("Error reading file: Error: denied");
    expect(text).not.toContain("File not found");
  });

  it("preserves POSIX and Windows path namespaces in suggestions", () => {
    const posix = readPathInfo("/workspace/src/app.ts");
    expect(posix.parent).toBe("/workspace/src");
    expect(posix.sibling("config.ts")).toBe("/workspace/src/config.ts");

    const windows = readPathInfo("D:\\repo\\src\\app.ts");
    expect(windows.parent).toBe("D:\\repo\\src");
    expect(windows.sibling("config.ts")).toBe("D:\\repo\\src\\config.ts");
  });
});

describe("read helpers", () => {
  it("splits lines without counting a trailing newline", () => {
    expect(splitReadLines("")).toEqual([]);
    expect(splitReadLines("\n")).toEqual([""]);
    expect(splitReadLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitReadLines("a\nb")).toEqual(["a", "b"]);
    expect(splitReadLines("a\r\n")).toEqual(["a\r"]);
  });

  it("detects binary content by NUL and by control-char ratio", () => {
    expect(isBinaryContent("hello\u0000world")).toBe(true);
    expect(isBinaryContent("hello world")).toBe(false);
    expect(isBinaryContent("tab\there\nand\r\nnewline")).toBe(false);
    expect(isBinaryContent("中文与 emoji 🙂 都正常")).toBe(false);
    expect(isBinaryContent("\u0001".repeat(200))).toBe(true);
  });

  it("truncates only lines beyond the per-line limit", () => {
    expect(truncateReadLine("short")).toBe("short");
    const long = "x".repeat(2500);
    const truncated = truncateReadLine(long);
    expect(truncated).toContain("(line truncated to 2000 chars)");
    expect(truncated.length).toBeLessThan(long.length);
  });

  it("emits every line when the file is small", () => {
    const slice = sliceReadLines(["one", "two", "three"], 1, 2000);
    expect(slice.lines).toEqual(["1: one", "2: two", "3: three"]);
    expect(slice.emitted).toBe(3);
    expect(slice.byteCapped).toBe(false);
  });

  it("honours offset and limit", () => {
    const slice = sliceReadLines(["one", "two", "three"], 2, 1);
    expect(slice.lines).toEqual(["2: two"]);
    expect(slice.emitted).toBe(1);
  });

  it("normalizes finite values and falls back for non-finite values", () => {
    expect(normalizeReadInteger(-5, 1)).toBe(1);
    expect(normalizeReadInteger(2.9, 1)).toBe(2);
    expect(normalizeReadInteger(Number.NaN, 1)).toBe(1);
    expect(normalizeReadInteger(Number.POSITIVE_INFINITY, 2000)).toBe(2000);
  });

  it("caps the byte budget and always emits at least one line", () => {
    const lines = Array.from({ length: 30 }, () => "a".repeat(1990));
    const slice = sliceReadLines(lines, 1, 2000);
    expect(slice.byteCapped).toBe(true);
    expect(slice.emitted).toBeGreaterThan(0);
    expect(slice.emitted).toBeLessThan(30);
    const totalBytes = slice.lines.reduce(
      (sum, line, index) => sum + Buffer.byteLength(line, "utf8") + (index > 0 ? 1 : 0),
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(MAX_READ_BYTES);
  });

  it("applies the same byte budget to directory entries", () => {
    const entries = Array.from({ length: 300 }, (_, index) => `${index}-${"x".repeat(240)}`);
    const slice = sliceDirectoryEntries(entries, 1, 2000);
    expect(slice.byteCapped).toBe(true);
    expect(slice.emitted).toBeGreaterThan(0);
    expect(slice.emitted).toBeLessThan(entries.length);
  });

  it("truncates an oversized first directory entry before applying the byte budget", () => {
    const slice = sliceDirectoryEntries(["x".repeat(MAX_READ_BYTES + 1)], 1, 2000);
    expect(slice.emitted).toBe(1);
    expect(slice.lines[0]).toContain("(line truncated to 2000 chars)");
    expect(Buffer.byteLength(slice.lines[0]!, "utf8")).toBeLessThanOrEqual(MAX_READ_BYTES);
  });

  it("builds the three trailer shapes", () => {
    expect(readTrailer({ offset: 1, emitted: 1, total: 3, byteCapped: false })).toBe(
      "(Showing lines 1-1 of 3. Use offset=2 to continue.)",
    );
    expect(readTrailer({ offset: 1, emitted: 3, total: 3, byteCapped: false })).toBe(
      "(End of file - total 3 lines)",
    );
    expect(readTrailer({ offset: 1, emitted: 2, total: 5, byteCapped: true })).toBe(
      "(Output capped at 50 KB. Showing lines 1-2. Use offset=3 to continue.)",
    );
    expect(readTrailer({ offset: 1, emitted: 0, total: 0, byteCapped: false })).toBe(
      "(End of file - total 0 lines)",
    );
  });

  it("suggests at most three mutually-containing names in stable order", () => {
    expect(suggestSimilarNames("config.ts", ["config.tsx", "other.md", "config.ts"])).toEqual([
      "config.ts",
      "config.tsx",
    ]);
    expect(suggestSimilarNames("config", ["config4", "config2", "config1", "config3"])).toEqual([
      "config1",
      "config2",
      "config3",
    ]);
    expect(suggestSimilarNames("missing.ts", ["a.ts", "b.ts", "c.ts", "d.ts"])).toEqual([]);
  });
});
