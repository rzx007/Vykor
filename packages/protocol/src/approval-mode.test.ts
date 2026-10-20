import { describe, expect, it } from "vitest";
import { effectivePermissionMode, normalizeApprovalMode } from "./approval-mode.js";
import { patchSessionRuntimeMetadata, readRuntimeMetadata } from "./runtime-config.js";

describe("independent authorization and planning", () => {
  it("upgrades old automatic approval without widening access", () => {
    expect(normalizeApprovalMode("full_auto")).toBe("auto_review");
    expect(normalizeApprovalMode("plan")).toBe("ask");
  });
  it("preserves authorization across entering and exiting planning", () => {
    const original = { runtime: { model: "offline", approvalMode: "auto_review", workMode: "execute" } };
    const plan = patchSessionRuntimeMetadata(original, { workMode: "plan" });
    const execute = patchSessionRuntimeMetadata(plan, { workMode: "execute" });
    expect(readRuntimeMetadata(execute)).toMatchObject({ approvalMode: "auto_review", workMode: "execute" });
  });
  it("keeps partial patches from resetting the other mode", () => {
    expect(patchSessionRuntimeMetadata({}, { workMode: "plan" })).toEqual({ runtime: { workMode: "plan" } });
    expect(patchSessionRuntimeMetadata({}, { approvalMode: "auto_review" })).toEqual({ runtime: { approvalMode: "auto_review" } });
  });
  it("canonicalizes a stored plan without losing its read-only ceiling", () => {
    const updated = patchSessionRuntimeMetadata({ runtime: { model: "offline", permissionMode: "plan" } }, { approvalMode: "full_access" });
    expect(readRuntimeMetadata(updated)).toEqual({ model: "offline", approvalMode: "full_access", workMode: "plan" });
    expect(effectivePermissionMode("full_access", "plan")).toBe("plan");
  });
});
