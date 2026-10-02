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

const shellSchema = {
  type: "object",
  properties: { command: { type: "string" } },
  required: ["command"],
};

function wrapArguments(input: Record<string, unknown>, depth: number): Record<string, unknown> {
  for (let i = 0; i < depth; i++) input = { arguments: input };
  return input;
}

describe("normalizeToolInput", () => {
  it.each([2, 8])("unwraps %i arguments layers without changing the command or source objects", (depth) => {
    const leaf = Object.freeze({ command: "Write-Output '$value'", workdir: "C:/workspace" });
    const input = wrapArguments(leaf, depth);
    const original = JSON.stringify(input);
    expect(normalizeToolInput(shellSchema, input)).toEqual({ command: "Write-Output '$value'", workdir: "C:/workspace" });
    expect(JSON.stringify(input)).toBe(original);
  });

  it("normalizes aliases inside the wrapper using the same strict schema rules", () => {
    const leaf = Object.freeze({ path: "src/a.ts", contents: "hello" });
    expect(normalizeToolInput({ ...writeSchema, additionalProperties: false }, wrapArguments(leaf, 2)))
      .toEqual({ file_path: "src/a.ts", content: "hello" });
    expect(leaf).toEqual({ path: "src/a.ts", contents: "hello" });
  });

  it("rejects nine layers without returning a partially unwrapped call", () => {
    const input = wrapArguments({ command: "Write-Output probe" }, 9);
    expect(normalizeToolInput(shellSchema, input)).toBe(input);
    expect(validateToolInput(shellSchema, normalizeToolInput(shellSchema, input))).not.toBeNull();
  });

  it("returns finitely for a cyclic wrapper", () => {
    const input: Record<string, unknown> = {};
    input.arguments = input;
    expect(normalizeToolInput(shellSchema, input)).toBe(input);
  });

  it("does not mistake a hidden arguments property for the sole enumerable key", () => {
    const input = { note: "keep" };
    Object.defineProperty(input, "arguments", { value: { command: "probe" }, enumerable: false });
    expect(normalizeToolInput(shellSchema, input)).toBe(input);
  });

  it.each([{ command: 123 }, {}, { arguments: "{\"command\":\"probe\"}" }, { arguments: [] }])(
    "does not invent or parse missing/wrongly typed parameters: %j", (leaf) => {
      const input = { arguments: leaf };
      expect(normalizeToolInput(shellSchema, input)).toBe(input);
      expect(validateToolInput(shellSchema, normalizeToolInput(shellSchema, input))).not.toBeNull();
    },
  );

  it.each([
    { arguments: { command: "probe" }, note: "keep" },
    { arguments: { arguments: { command: "probe" }, note: "keep" } },
  ])("does not discard sibling fields at any wrapping layer", (input) => {
    expect(normalizeToolInput(shellSchema, input)).toBe(input);
  });

  it("keeps an already valid business input even when its inner arguments also look valid", () => {
    const optionalSchema = { type: "object", properties: { command: { type: "string" } } };
    const input = { arguments: { command: "probe" } };
    expect(normalizeToolInput(optionalSchema, input)).toBe(input);
  });

  it.each(["anyOf", "oneOf", "allOf", "$ref"])("does not guess wrappers for a %s schema", (key) => {
    const schema = { ...shellSchema, [key]: key === "$ref" ? "#/$defs/input" : [shellSchema] };
    const input = { arguments: { command: "probe" } };
    expect(normalizeToolInput(schema, input)).toBe(input);
  });

  it.each(["anyOf", "oneOf", "allOf", "$ref"])("does not correct aliases in an ambiguous %s schema", key => {
    const schema = { ...writeSchema, [key]: key === "$ref" ? "#/$defs/input" : [writeSchema] };
    const input = { path: "target.txt", contents: "body" };
    expect(normalizeToolInput(schema, input)).toBe(input);
  });

  it.each([
    { type: "object", allOf: [
      { properties: { file_path: { type: "string" } }, required: ["file_path"] },
      { properties: { path: { type: "string" } }, required: ["path"] },
    ] },
    { type: "object", anyOf: [
      { properties: { file_path: { type: "string" }, path: { type: "string" } }, required: ["file_path", "path"] },
    ] },
  ])("keeps composed business fields under their original structure validation: %j", schema => {
    const input = { file_path: "target.txt", path: "business.txt" };
    expect(normalizeToolInput(schema, input)).toBe(input);
    expect(validateToolInput(schema, input)).toBeNull();
    expect(validateToolInput(schema, { file_path: 123, path: "business.txt" })).not.toBeNull();
    expect(validateToolInput(schema, { file_path: "target.txt" })).not.toBeNull();
  });

  it("stops alias inference inside a nested composed business object", () => {
    const schema = { type: "object", properties: { payload: { type: "object", allOf: [
      { properties: { file_path: { type: "string" } }, required: ["file_path"] },
      { properties: { path: { type: "string" } }, required: ["path"] },
    ] } }, required: ["payload"] };
    expect(validateToolInput(schema, { payload: { file_path: "target.txt", path: "business.txt" } })).toBeNull();
    expect(validateToolInput(schema, { payload: { file_path: 123, path: "business.txt" } })).not.toBeNull();
  });

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

  it.each([
    { file_path: "private.txt", path: "public.txt", content: "body" },
    { file_path: "private.txt", filePath: "public.txt", content: "body" },
    { path: "private.txt", filePath: "public.txt", content: "body" },
    { file_path: "private.txt", content: "one", contents: "two" },
  ])("rejects conflicting non-business aliases: %j", input => {
    for (const schema of [writeSchema, { ...writeSchema, additionalProperties: false }]) {
      expect(validateToolInput(schema, normalizeToolInput(schema, input))).not.toBeNull();
    }
  });

  it("rejects conflicting aliases inside multiple arguments wrappers", () => {
    const input = wrapArguments({ file_path: "private.txt", path: "public.txt", content: "body" }, 3);
    expect(validateToolInput(writeSchema, normalizeToolInput(writeSchema, input))).not.toBeNull();
  });

  it("accepts identical aliases including strict schemas", () => {
    const input = { file_path: "same.txt", path: "same.txt", filePath: "same.txt", content: "body", contents: "body" };
    const schema = { ...writeSchema, additionalProperties: false };
    expect(normalizeToolInput(schema, input)).toEqual({ file_path: "same.txt", content: "body" });
    expect(validateToolInput(schema, normalizeToolInput(schema, input))).toBeNull();
  });

  it("preserves independently declared business fields", () => {
    const schema = { ...writeSchema, properties: { ...writeSchema.properties, path: { type: "string" }, contents: { type: "string" } } };
    const input = { file_path: "target.txt", path: "business.txt", content: "one", contents: "two" };
    expect(normalizeToolInput(schema, input)).toEqual(input);
    expect(validateToolInput(schema, input)).toBeNull();
    expect(normalizeToolInput(schema, { path: "business.txt", contents: "two" }))
      .toEqual({ path: "business.txt", contents: "two" });
    expect(validateToolInput(schema, normalizeToolInput(schema, { path: "business.txt", contents: "two" }))).not.toBeNull();
  });

  it.each(["constructor", "toString"])("accepts a JSON business field named %s without inheriting an alias entry", key => {
    const schema = JSON.parse(`{"type":"object","properties":{"${key}":{"type":"string"}},"required":["${key}"]}`);
    const input = JSON.parse(`{"${key}":"business value"}`);
    expect(normalizeToolInput(schema, input)).toEqual({ [key]: "business value" });
    expect(validateToolInput(schema, input)).toBeNull();
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
