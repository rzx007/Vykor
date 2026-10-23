import { describe, expect, it } from "vitest";
import { resolveEffectiveToolPermissions } from "../tools.js";

describe("resolveEffectiveToolPermissions", () => {
  it("intersects tool requests with plugin-level permissions", () => {
    expect(resolveEffectiveToolPermissions(
      { filesystem: ["read"], network: ["example.test"] },
      ["filesystem:read", "network.example.test"],
    )).toEqual({
      permissions: { filesystem: ["read"], network: ["example.test"] },
      denied: [],
    });
  });

  it("rejects unknown and undeclared permissions", () => {
    expect(resolveEffectiveToolPermissions(
      { process: ["spawn"] },
      ["process.spawn", "filesystem:write", "host.admin"],
    )).toEqual({
      permissions: { process: ["spawn"] },
      denied: ["filesystem:write", "host.admin"],
    });
  });
});
