import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileEditTool } from "../edit.js";

describe("fileEditTool", () => {
  it("reports the line of every ambiguous match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-matches-"));
    try {
      const file = join(dir, "repeated.txt");
      await writeFile(file, "same\nother\nsame\nsame\n", "utf-8");

      const result = await fileEditTool.execute!(
        { file_path: file, old_string: "same", new_string: "new" },
        {
          cwd: dir,
          settings: {
            model: "m",
            apiFormat: "openai",
            maxTurns: 1,
            permission: { mode: "default" },
            sandbox: { enabled: false },
          },
        },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as { type: "text"; text: string }).text)
        .toBe("Found 3 matches at lines 1, 3, 4. Make old_string more specific or use replace_all to replace all.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects edits when sandbox read access is denied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-sandbox-"));
    try {
      const file = join(dir, "secret.txt");
      await writeFile(file, "old", "utf-8");

      const result = await fileEditTool.execute!(
        { file_path: file, old_string: "old", new_string: "new" },
        {
          cwd: dir,
          settings: {
            model: "m",
            apiFormat: "openai",
            maxTurns: 1,
            permission: { mode: "default" },
            sandbox: {
              enabled: true,
              filesystem: {
                allowRead: ["."],
                denyRead: ["secret.txt"],
                allowWrite: ["."],
              },
            },
          },
        },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("denied by sandbox rule");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const settings = {
    model: "m",
    apiFormat: "openai" as const,
    maxTurns: 1,
    permission: { mode: "default" as const },
    sandbox: { enabled: false },
  };

  it("recovers an edit when only indentation differs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-indent-"));
    try {
      const file = join(dir, "code.ts");
      await writeFile(file, "function f() {\n    return 1;\n}\n", "utf-8");

      const result = await fileEditTool.execute!(
        {
          file_path: file,
          old_string: "function f() {\n  return 1;\n}",
          new_string: "function f() {\n  return 2;\n}",
        },
        { cwd: dir, settings },
      );

      expect(result.isError).toBeFalsy();
      expect(await readFile(file, "utf-8")).toContain("return 2;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers an edit when the file is CRLF and old_string is LF", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-crlf-"));
    try {
      const file = join(dir, "win.txt");
      await writeFile(file, "alpha\r\nbeta\r\ngamma\r\n", "utf-8");

      const result = await fileEditTool.execute!(
        { file_path: file, old_string: "beta\ngamma", new_string: "BETA\nGAMMA" },
        { cwd: dir, settings },
      );

      expect(result.isError).toBeFalsy();
      const after = await readFile(file, "utf-8");
      expect(after).toContain("BETA\r\nGAMMA");
      expect(after).not.toContain("BETA\nGAMMA");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves a UTF-8 BOM when editing the first line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-bom-"));
    try {
      const file = join(dir, "bom.txt");
      await writeFile(file, "\uFEFFtitle\nbody\n", "utf-8");

      const result = await fileEditTool.execute!(
        { file_path: file, old_string: "title", new_string: "TITLE" },
        { cwd: dir, settings },
      );

      expect(result.isError).toBeFalsy();
      expect(await readFile(file, "utf-8")).toBe("\uFEFFTITLE\nbody\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an edit when old_string equals new_string even if the text exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-same-"));
    try {
      const file = join(dir, "same.txt");
      await writeFile(file, "keep me\n", "utf-8");

      const result = await fileEditTool.execute!(
        { file_path: file, old_string: "keep me", new_string: "keep me" },
        { cwd: dir, settings },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as { type: string; text: string }).text).toBe(
        "No changes to apply: oldString and newString are identical.",
      );
      expect(await readFile(file, "utf-8")).toBe("keep me\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports ambiguous when a CRLF file has multiple normalized matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-ambig-crlf-"));
    try {
      const file = join(dir, "multi.txt");
      await writeFile(file, "alpha\r\nbeta\r\nother\r\nalpha\r\nbeta\r\n", "utf-8");

      const result = await fileEditTool.execute!(
        { file_path: file, old_string: "alpha\nbeta", new_string: "ALPHA\nBETA" },
        { cwd: dir, settings },
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as { type: string; text: string }).text).toBe(
        "Found multiple matches for oldString. Provide more surrounding context to make the match unique.",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers an edit when whitespace run lengths differ", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-whitespace-"));
    try {
      const file = join(dir, "spacing.ts");
      await writeFile(file, "const value   =   1;\n", "utf-8");
      const result = await fileEditTool.execute!(
        { file_path: file, old_string: "const value = 1;", new_string: "const value = 2;" },
        { cwd: dir, settings },
      );
      expect(result.isError).toBeFalsy();
      expect(await readFile(file, "utf-8")).toBe("const value = 2;\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers an edit when old_string contains literal escapes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-escape-"));
    try {
      const file = join(dir, "escaped.txt");
      await writeFile(file, "alpha\nbeta\n", "utf-8");
      const result = await fileEditTool.execute!(
        { file_path: file, old_string: "alpha\\nbeta", new_string: "ALPHA\nBETA" },
        { cwd: dir, settings },
      );
      expect(result.isError).toBeFalsy();
      expect(await readFile(file, "utf-8")).toBe("ALPHA\nBETA\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replaces every exact occurrence when replace_all is true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-all-"));
    try {
      const file = join(dir, "all.txt");
      await writeFile(file, "old / old / old", "utf-8");
      const result = await fileEditTool.execute!(
        { file_path: file, old_string: "old", new_string: "new", replace_all: true },
        { cwd: dir, settings },
      );
      expect(result.isError).toBeFalsy();
      expect(await readFile(file, "utf-8")).toBe("new / new / new");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the existing not-found message and does not modify the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-missing-"));
    try {
      const file = join(dir, "missing.txt");
      await writeFile(file, "original\n", "utf-8");
      const result = await fileEditTool.execute!(
        { file_path: file, old_string: "absent", new_string: "new" },
        { cwd: dir, settings },
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as { type: string; text: string }).text).toBe(
        "old_string not found in file.",
      );
      expect(await readFile(file, "utf-8")).toBe("original\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects multiple different fuzzy locations and leaves the file unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-fuzzy-ambiguous-"));
    try {
      const file = join(dir, "ambiguous.ts");
      const before = [
        "if (ready) {", "    run();", "}",
        "if (ready) {", "      run();", "}",
      ].join("\n");
      await writeFile(file, before, "utf-8");
      const result = await fileEditTool.execute!(
        {
          file_path: file,
          old_string: "if (ready) {\n  run();\n}",
          new_string: "if (ready) {\n  stop();\n}",
        },
        { cwd: dir, settings },
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as { type: string; text: string }).text).toBe(
        "Found multiple matches for oldString. Provide more surrounding context to make the match unique.",
      );
      expect(await readFile(file, "utf-8")).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not expand a whitespace-only fuzzy search when replace_all is true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-empty-candidate-"));
    try {
      const file = join(dir, "blank.txt");
      const before = "alpha\n\nbeta\n";
      await writeFile(file, before, "utf-8");
      const result = await fileEditTool.execute!(
        { file_path: file, old_string: "   ", new_string: "X", replace_all: true },
        { cwd: dir, settings },
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as { type: string; text: string }).text).toBe(
        "old_string not found in file.",
      );
      expect(await readFile(file, "utf-8")).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats an old_string containing only BOM as empty after BOM normalization", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-bom-only-"));
    try {
      const file = join(dir, "bom-only.txt");
      const before = "\uFEFFtitle\n";
      await writeFile(file, before, "utf-8");
      const result = await fileEditTool.execute!(
        { file_path: file, old_string: "\uFEFF", new_string: "X", replace_all: true },
        { cwd: dir, settings },
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as { type: string; text: string }).text).toBe(
        "old_string must not be empty.",
      );
      expect(await readFile(file, "utf-8")).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps sandbox denial ahead of the identical-string check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-edit-identical-sandbox-"));
    try {
      const file = join(dir, "secret.txt");
      await writeFile(file, "same", "utf-8");
      const result = await fileEditTool.execute!(
        { file_path: file, old_string: "same", new_string: "same" },
        {
          cwd: dir,
          settings: {
            ...settings,
            sandbox: {
              enabled: true,
              filesystem: { allowRead: ["."], denyRead: ["secret.txt"], allowWrite: ["."] },
            },
          },
        },
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as { type: string; text: string }).text)
        .toContain("denied by sandbox rule");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
