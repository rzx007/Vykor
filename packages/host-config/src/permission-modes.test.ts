import { describe, expect, it } from "vitest";
import { isWorkMode, normalizeApprovalMode } from "./permission-modes.js";

describe("stored permission modes", () => {
  it.each([
    ["ask", "ask"], ["auto_review", "auto_review"], ["full_access", "full_access"],
    ["default", "ask"], ["plan", "ask"], ["full_auto", "auto_review"],
    ["unknown", undefined], ["", undefined], [null, undefined], [undefined, undefined], [1, undefined], [{}, undefined],
  ])("normalizes %s without broadening access", (value, expected) => {
    expect(normalizeApprovalMode(value)).toBe(expected);
  });

  it("recognizes only the two explicit work modes", () => {
    expect(isWorkMode("execute")).toBe(true);
    expect(isWorkMode("plan")).toBe(true);
    for (const value of ["default", "full_auto", "ask", undefined, null, {}, 1]) expect(isWorkMode(value)).toBe(false);
  });
});
