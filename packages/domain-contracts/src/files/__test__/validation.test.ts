import { describe, expect, it } from "vitest";
import * as files from "../index.js";

describe("session file request parsing", () => {
  it("accepts HTTP integer and boolean query strings without adding defaults", () => {
    expect(files.parseSessionFileListInput({})).toEqual({});
    expect(files.parseSessionFileListInput({ path: ".", limit: "1000" })).toEqual({ path: ".", limit: 1000 });
    expect(files.parseSessionFileStatInput({ path: "src/file.ts" })).toEqual({ path: "src/file.ts" });
    expect(files.parseSessionFileReadInput({ path: "README.md", maxBytes: "1048576" })).toEqual({ path: "README.md", maxBytes: 1048576 });
    expect(files.parseSessionFileFindInput({ pattern: "**/*.ts", limit: "1000" })).toEqual({ pattern: "**/*.ts", limit: 1000 });
    expect(files.parseSessionFileSearchInput({ query: "[literal]", include: "**/*.ts", caseSensitive: "false", limit: "200" })).toEqual({ query: "[literal]", include: "**/*.ts", caseSensitive: false, limit: 200 });
    expect(files.parseSessionFileSearchInput({ query: "text", caseSensitive: "true" })).toEqual({ query: "text", caseSensitive: true });
  });

  it("rejects unknown fields, invalid types and out-of-range limits", () => {
    const invalid = [
      () => files.parseSessionFileListInput({ cwd: "/host" }),
      () => files.parseSessionFileStatInput({ path: "a", signal: {} }),
      () => files.parseSessionFileReadInput({ path: "a", maxBytes: 1048577 }),
      () => files.parseSessionFileFindInput({ pattern: "*", limit: 1001 }),
      () => files.parseSessionFileSearchInput({ query: "a", limit: 201 }),
      ...[0, -1, 1.5, true, null, "", " 2", "1e2", "2.0", "Infinity", []].map(limit => () => files.parseSessionFileListInput({ limit })),
      ...[null, "", "yes", 1, []].map(caseSensitive => () => files.parseSessionFileSearchInput({ query: "a", caseSensitive })),
      ...[undefined, null, [], "", new Date()].map(value => () => files.parseSessionFileListInput(value)),
      () => files.parseSessionFileStatInput({}),
      () => files.parseSessionFileFindInput({ pattern: "" }),
      () => files.parseSessionFileFindInput({ pattern: "a".repeat(257) }),
      () => files.parseSessionFileSearchInput({ query: "" }),
      () => files.parseSessionFileSearchInput({ query: "first\nsecond" }),
      () => files.parseSessionFileSearchInput({ query: "a".repeat(257) }),
      () => files.parseSessionFileSearchInput({ query: "a", include: "" }),
      () => files.parseSessionFileFindInput({ pattern: "a\0b" }),
      () => files.parseSessionFileFindInput({ pattern: "../*" }),
      () => files.parseSessionFileSearchInput({ query: "a", include: "/host/*" }),
    ];
    for (const parse of invalid) {
      expect(parse).toThrowError(expect.objectContaining({ code: "file_invalid_request" }));
    }
  });

  it("accepts workspace paths and rejects traversal and host paths", () => {
    for (const path of [".", "src/file.ts", "./src/file.ts", "notes:old.md"]) {
      expect(files.parseSessionFileStatInput({ path })).toEqual({ path });
    }
    for (const path of ["", "/etc/passwd", "C:/Users/file", "../file", "a/../file", "a\\file", "a\0b", "a".repeat(4097)]) {
      expect(() => files.parseSessionFileStatInput({ path })).toThrowError(expect.objectContaining({ code: "file_invalid_request" }));
    }
  });

  it("uses a stable error class and error code", () => {
    const error = new files.SessionFileError("file_forbidden", "Access denied");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "SessionFileError", code: "file_forbidden", message: "Access denied" });
  });
});
