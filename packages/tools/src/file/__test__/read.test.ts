import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileReadTool } from "../read.js";

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

      expect((result.content[0] as any).text).toBe("2: two");
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
      expect((result.content[0] as { text: string }).text).toContain("Unsupported binary file");
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
});
