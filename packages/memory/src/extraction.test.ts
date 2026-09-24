import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildMemoryExtractionPrompt,
  isMemoryWriteToolCall,
  parseMemoryExtractionRecords,
  selectWritableMemoryExtractionRecords,
} from "./extraction.js";

describe("parseMemoryExtractionRecords", () => {
  it("parses noisy JSON and normalizes missing type, scope, description, and tags", () => {
    const records = parseMemoryExtractionRecords(
      'model preface\n{"memories":[{"title":" Deploy notes ","body":" Use pnpm ","tags":[" build ","",42]}]}\nmodel epilogue',
    );

    expect(records).toEqual([
      {
        title: "Deploy notes",
        body: "Use pnpm",
        description: "",
        memoryType: "project",
        scope: "project",
        tags: ["build", "42"],
      },
    ]);
  });

  it("returns no records for malformed JSON, a wrong payload shape, or incomplete records", () => {
    expect(parseMemoryExtractionRecords('{"memories": [}')).toEqual([]);
    expect(parseMemoryExtractionRecords('{"memories":"wrong"}')).toEqual([]);
    expect(
      parseMemoryExtractionRecords(
        '{"memories":[{"title":"","body":"body"},{"title":"title"},null]}',
      ),
    ).toEqual([]);
  });

  it("never returns more than three normalized records", () => {
    const response = JSON.stringify({
      memories: Array.from({ length: 5 }, (_, index) => ({
        title: `title-${index}`,
        body: `body-${index}`,
      })),
    });

    expect(parseMemoryExtractionRecords(response)).toHaveLength(3);
    expect(parseMemoryExtractionRecords(response, 2)).toHaveLength(2);
    expect(parseMemoryExtractionRecords(response, 10)).toHaveLength(3);
  });
});

describe("selectWritableMemoryExtractionRecords", () => {
  it("filters team-scoped records without changing private or project records", () => {
    const records = parseMemoryExtractionRecords(
      JSON.stringify({
        memories: [
          { title: "team", body: "shared", scope: "team" },
          { title: "private", body: "personal", scope: "private" },
          { title: "project", body: "workspace", scope: "project" },
        ],
      }),
    );

    expect(selectWritableMemoryExtractionRecords(records).map((record) => record.title)).toEqual([
      "private",
      "project",
    ]);
  });
});

describe("buildMemoryExtractionPrompt", () => {
  it("builds the shared extraction input from an existing manifest and adapted transcript", () => {
    const prompt = buildMemoryExtractionPrompt(
      "- existing: description",
      ["user: remember pnpm", "assistant: noted"],
      9,
    );

    expect(prompt).toContain("Return JSON with at most 3 records");
    expect(prompt).toContain("- existing: description");
    expect(prompt).toContain("user: remember pnpm\nassistant: noted");
    expect(prompt).toContain('"scope":"private|project|team"');
  });
});

describe("isMemoryWriteToolCall", () => {
  const cwd = resolve(join("workspace", "project"));
  const memoryDir = join(cwd, ".vykor", "memory");

  it("detects Write/Edit calls inside the memory directory for both supported path keys", () => {
    expect(
      isMemoryWriteToolCall(
        "Write",
        { file_path: join(memoryDir, "facts.md") },
        memoryDir,
      ),
    ).toBe(true);
    expect(
      isMemoryWriteToolCall(
        "Edit",
        { path: join(".vykor", "memory", "facts.md") },
        memoryDir,
        cwd,
      ),
    ).toBe(true);
  });

  it("rejects other tools and paths that merely share the directory prefix", () => {
    expect(
      isMemoryWriteToolCall(
        "Read",
        { path: join(memoryDir, "facts.md") },
        memoryDir,
      ),
    ).toBe(false);
    expect(
      isMemoryWriteToolCall(
        "Write",
        { path: join(`${memoryDir}-archive`, "facts.md") },
        memoryDir,
      ),
    ).toBe(false);
  });
});
