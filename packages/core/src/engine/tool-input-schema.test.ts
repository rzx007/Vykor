import { describe, expect, it } from "vitest";
import { normalizeToolInput, validateToolInput } from "./tool-input-schema";

const writeSchema = {
  type: "object",
  properties: {
    file_path: { type: "string" },
    content: { type: "string" },
  },
  required: ["file_path", "content"],
};

const readSchema = {
  type: "object",
  properties: {
    file_path: { type: "string" },
    offset: { type: "number" },
    limit: { type: "number" },
  },
  required: ["file_path"],
};

const notebookSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    cellIndex: { type: "number" },
    newSource: { type: "string" },
  },
  required: ["path", "cellIndex", "newSource"],
};

describe("normalizeToolInput", () => {
  it("unwraps a sole arguments object when it satisfies the tool schema", () => {
    const shellSchema = {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    };

    expect(normalizeToolInput(shellSchema, {
      arguments: { command: "git status --short" },
    })).toEqual({ command: "git status --short" });
  });

  it("keeps an arguments object when unwrapping would not satisfy the schema", () => {
    expect(normalizeToolInput(readSchema, {
      arguments: { offset: 10 },
    })).toEqual({ arguments: { offset: 10 } });
  });

  it("keeps arguments when the schema declares it or sibling fields exist", () => {
    const schemaWithArguments = {
      type: "object",
      properties: { arguments: { type: "object" } },
      required: ["arguments"],
    };

    expect(normalizeToolInput(schemaWithArguments, {
      arguments: { command: "git status" },
    })).toEqual({ arguments: { command: "git status" } });
    expect(normalizeToolInput(readSchema, {
      arguments: { file_path: "a.ts" },
      note: "keep",
    })).toEqual({ arguments: { file_path: "a.ts" }, note: "keep" });
  });

  it("copies path and contents onto Write file_path and content", () => {
    expect(
      normalizeToolInput(writeSchema, {
        path: "/tmp/notes.ts",
        contents: "export {}",
      }),
    ).toEqual({
      path: "/tmp/notes.ts",
      contents: "export {}",
      file_path: "/tmp/notes.ts",
      content: "export {}",
    });
  });

  it("copies Edit camelCase fields onto snake_case schema names", () => {
    expect(
      normalizeToolInput(
        {
          type: "object",
          properties: {
            file_path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
        },
        { path: "a.ts", oldString: "foo", newString: "bar", replaceAll: true },
      ),
    ).toMatchObject({
      file_path: "a.ts",
      old_string: "foo",
      new_string: "bar",
      replace_all: true,
    });
  });

  it("copies filePath onto file_path", () => {
    expect(
      normalizeToolInput(readSchema, { filePath: "src/a.ts" }),
    ).toMatchObject({ file_path: "src/a.ts" });
  });

  it("copies file_path onto path when the schema uses path", () => {
    expect(
      normalizeToolInput(notebookSchema, {
        file_path: "nb.ipynb",
        cellIndex: 0,
        newSource: "print(1)",
      }),
    ).toMatchObject({ path: "nb.ipynb" });
  });

  it("keeps the canonical field when both names are present", () => {
    expect(
      normalizeToolInput(writeSchema, {
        file_path: "/canonical.ts",
        path: "/alias.ts",
        content: "keep",
        contents: "ignore",
      }),
    ).toMatchObject({
      file_path: "/canonical.ts",
      content: "keep",
    });
  });

  it("does not invent fields that the schema does not declare", () => {
    expect(normalizeToolInput({ type: "object", properties: { query: { type: "string" } } }, { path: "x" }))
      .toEqual({ path: "x" });
  });

  it("leaves non-object input unchanged", () => {
    expect(normalizeToolInput(writeSchema, "oops")).toBe("oops");
    expect(normalizeToolInput(writeSchema, undefined)).toBeUndefined();
  });

  it("drops copied aliases when additionalProperties is false", () => {
    expect(
      normalizeToolInput(
        { ...writeSchema, additionalProperties: false },
        { path: "/tmp/a.ts", contents: "ok" },
      ),
    ).toEqual({
      file_path: "/tmp/a.ts",
      content: "ok",
    });
  });
});

describe("validateToolInput after alias normalization", () => {
  it("accepts Cursor-style Write arguments", () => {
    const input = normalizeToolInput(writeSchema, {
      path: "/tmp/notes.ts",
      contents: "hello",
    });
    expect(validateToolInput(writeSchema, input)).toBeNull();
  });

  it("still rejects Write calls that omit every path alias", () => {
    const input = normalizeToolInput(writeSchema, { content: "hello" });
    expect(validateToolInput(writeSchema, input)).toBe(
      'input missing required property "file_path"',
    );
  });
});
