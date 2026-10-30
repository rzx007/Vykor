import { describe, expect, it } from "vitest";
import * as protocol from "../../index.js";

describe("session file response decoding", () => {
  const file = { path: "src/a.ts", name: "a.ts", kind: "file", sizeBytes: 8, modifiedAt: 123 };

  it("returns typed complete results for each operation", () => {
    expect(protocol.decodeSessionDirectoryResult({ path: ".", entries: [file], truncated: false })).toEqual({ path: ".", entries: [file], truncated: false });
    expect(protocol.decodeSessionFileInfo(file)).toEqual(file);
    expect(protocol.decodeSessionTextFileResult({ path: "a", content: "中文", encoding: "utf-8", truncated: true })).toEqual({ path: "a", content: "中文", encoding: "utf-8", truncated: true });
    expect(protocol.decodeSessionFindFilesResult({ path: ".", files: ["src/a.ts"], truncated: false })).toEqual({ path: ".", files: ["src/a.ts"], truncated: false });
    expect(protocol.decodeSessionSearchFilesResult({ path: ".", matches: [{ path: "a", line: 1, text: "hello" }], truncated: false })).toEqual({ path: ".", matches: [{ path: "a", line: 1, text: "hello" }], truncated: false });
  });

  it("rejects missing and malformed response fields instead of claiming valid data", () => {
    for (const decode of [
      () => protocol.decodeSessionDirectoryResult({ path: ".", entries: [] }),
      () => protocol.decodeSessionDirectoryResult({ path: ".", entries: [{}], truncated: false }),
      () => protocol.decodeSessionFileInfo({ ...file, kind: "socket" }),
      () => protocol.decodeSessionFileInfo({ ...file, sizeBytes: -1 }),
      () => protocol.decodeSessionFileInfo({ ...file, modifiedAt: "123" }),
      () => protocol.decodeSessionFileInfo({ ...file, path: "/host/file" }),
      () => protocol.decodeSessionTextFileResult({ path: "a", content: "x", encoding: "base64", truncated: false }),
      () => protocol.decodeSessionFindFilesResult({ path: ".", files: null, truncated: false }),
      () => protocol.decodeSessionSearchFilesResult({ path: ".", matches: [{ path: "a", line: 0, text: "x" }], truncated: false }),
    ]) expect(decode).toThrowError(protocol.ProtocolDataError);
  });
});
