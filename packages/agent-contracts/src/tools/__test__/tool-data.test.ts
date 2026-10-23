import { describe, expect, it } from "vitest";
import { MCP_CALL_RESULT_MAX_BYTES, mcpResultModelText, normalizeMcpToolMetadata, parseMcpCallResultData, publicToolResult } from "../tool-data.js";

describe("MCP application result transport", () => {
  const raw = { content: [{ type: "text", text: " saved " }], structuredContent: { documentId: "note-1", revision: 2 }, _meta: { uiOnly: { cursor: 8 } }, isError: false };
  it("preserves complete private JSON in an independent copy while model text stays unchanged", () => {
    const parsed = parseMcpCallResultData(raw);
    expect(parsed).toEqual(raw);
    expect(parsed).not.toBe(raw);
    expect(parsed._meta).not.toBe(raw._meta);
    expect(mcpResultModelText(parsed)).toBe(" saved ");
    expect(JSON.stringify(publicToolResult({ content: raw.content, mcpResult: parsed, metadata: { appData: raw._meta } }))).not.toContain("uiOnly");
  });
  it("uses structured JSON only when no nonblank original text exists and does not stringify images", () => {
    expect(mcpResultModelText(parseMcpCallResultData({ ...raw, content: [{ type: "text", text: " " }] }))).toBe(JSON.stringify(raw.structuredContent));
    expect(mcpResultModelText(parseMcpCallResultData({ content: [{ type: "image", data: "private-image", mimeType: "image/png" }], _meta: raw._meta }))).toBe("(no output)");
  });
  it("rejects invalid, cyclic, executable and overlarge JSON with no private values in errors", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const getter = Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("private getter executed"); } });
    for (const invalid of [undefined, NaN, 1n, cycle, getter, new Date(), new Array(2), { secret: undefined }]) {
      expect(() => parseMcpCallResultData({ content: [], _meta: { invalid } })).toThrow(/MCP result/);
    }
    expect(() => parseMcpCallResultData({ content: [], _meta: { uiOnly: "x".repeat(MCP_CALL_RESULT_MAX_BYTES) } })).toThrow("1 MiB");
    expect(() => parseMcpCallResultData({ content: [], _meta: { uiOnly: "\u0000".repeat(200_000) } })).toThrow("1 MiB");
    expect(() => parseMcpCallResultData({ content: [{ type: "text", text: 9 }] })).toThrow("Invalid MCP call result shape");
  });
  it("rejects excessive depth without recursive serialization", () => {
    let nested: unknown = null;
    for (let i = 0; i < 35; i++) nested = { nested };
    expect(() => parseMcpCallResultData({ content: [], _meta: { nested } })).toThrow("complexity");
  });
});

describe("MCP tool presentation metadata", () => {
  it("normalizes explicit app-only visibility even without a UI resource and omits arbitrary metadata", () => {
    expect(normalizeMcpToolMetadata({ _meta: { ui: { visibility: ["app"] }, private: "hidden" }, annotations: { readOnlyHint: true, permission: "allow" } }))
      .toEqual({ ui: { visibility: ["app"] }, annotations: { readOnlyHint: true } });
    expect(normalizeMcpToolMetadata({ _meta: { ui: { resourceUri: "ui://notes/panel" } } })).toEqual({ ui: { resourceUri: "ui://notes/panel", visibility: ["model", "app"] } });
  });
  it.each([null, [], ["other"], "app", ["app", false]])("rejects invalid visibility instead of widening it: %j", visibility => {
    expect(() => normalizeMcpToolMetadata({ _meta: { ui: { visibility } } })).toThrow("visibility");
  });
});
