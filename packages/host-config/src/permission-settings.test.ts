import { describe, expect, it } from "vitest";
import { parsePermissionSettings } from "./permission-settings.js";

describe("parsePermissionSettings", () => {
  it("validates and keeps ordered path rules and explicit empty lists", () => {
    expect(
      parsePermissionSettings({
        mode: "default",
        deniedTools: [],
        pathRules: [
          { pattern: "private/*", allow: false },
          { pattern: "*", allow: true },
        ],
      }),
    ).toEqual({
      mode: "default",
      deniedTools: [],
      pathRules: [
        { pattern: "private/*", allow: false },
        { pattern: "*", allow: true },
      ],
    });
  });
  it.each([
    null,
    { mode: "unknown" },
    { mode: ["default"] },
    { mode: "default", deniedTools: "Shell" },
    { mode: "default", deniedTools: [""] },
    { mode: "default", pathRules: [{ pattern: "*", allow: "false" }] },
    { mode: "default", magicApproval: true },
  ])("rejects malformed rules instead of persisting them: %j", (value) => {
    expect(() => parsePermissionSettings(value)).toThrow();
  });
});
