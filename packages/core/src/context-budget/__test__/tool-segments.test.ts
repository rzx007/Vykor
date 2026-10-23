import { describe, expect, it } from "vitest";

import { toolSchemasToLedgerSegments } from "../tool-segments.js";

describe("toolSchemasToLedgerSegments", () => {
  it("marks builtin schemas as tools and mcp schemas as mcp", () => {
    const segments = toolSchemasToLedgerSegments([
      { kind: "builtin", text: '{"name":"Read","parameters":{}}' },
      { kind: "mcp", text: '{"name":"mcp__x__y","parameters":{}}' },
    ]);
    expect(segments.map((s) => s.bucket)).toEqual(["tools", "mcp"]);
  });
});
