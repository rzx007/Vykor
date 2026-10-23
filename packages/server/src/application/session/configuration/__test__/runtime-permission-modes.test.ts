import { describe, expect, it } from "vitest";
import { patchSessionRuntimeMetadata } from "../runtime-configuration.js";
import { readRuntimeMetadata } from "@vykor/domain-contracts/sessions/runtime-config";

describe("independent authorization and planning", () => {
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
  });
});
