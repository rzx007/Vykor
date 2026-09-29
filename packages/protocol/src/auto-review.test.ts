import { describe, expect, it } from "vitest";
import { readAutoReviewRunMetadata } from "./auto-review.js";

const validMetadata = {
  version: 1 as const,
  policyVersion: "risk-v1" as const,
  mode: "risk_based" as const,
  riskLevel: "high" as const,
  status: "findings" as const,
  reasons: ["sensitive_path", "large_change"],
  reviewTaskId: "child-review-1",
  verdict: "fail" as const,
  findingCount: 2,
  highestSeverity: "important" as const,
  patchTruncated: false,
  startedAt: 100,
  finishedAt: 200,
};

describe("readAutoReviewRunMetadata", () => {
  it("round-trips a fully populated record", () => {
    expect(readAutoReviewRunMetadata(validMetadata)).toEqual(validMetadata);
  });

  it("round-trips a minimal record", () => {
    const minimal = {
      version: 1,
      policyVersion: "risk-v1",
      mode: "off",
      riskLevel: "none",
      status: "disabled",
      reasons: [],
    };
    expect(readAutoReviewRunMetadata(minimal)).toEqual(minimal);
  });

  it.each([
    ["null", null],
    ["a string", "metadata"],
    ["an array", []],
    ["a wrong version", { ...validMetadata, version: 2 }],
    ["a wrong policy version", { ...validMetadata, policyVersion: "risk-v2" }],
    ["an unknown mode", { ...validMetadata, mode: "always" }],
    ["an unknown risk level", { ...validMetadata, riskLevel: "critical" }],
    ["an unknown status", { ...validMetadata, status: "reviewing" }],
    ["a missing status", { ...validMetadata, status: undefined }],
    ["a non-string review task id", { ...validMetadata, reviewTaskId: 42 }],
    ["a negative finding count", { ...validMetadata, findingCount: -1 }],
    ["a fractional finding count", { ...validMetadata, findingCount: 1.5 }],
    ["a non-safe finding count", { ...validMetadata, findingCount: Number.MAX_SAFE_INTEGER + 1 }],
    ["a negative start time", { ...validMetadata, startedAt: -1 }],
    ["a non-finite end time", { ...validMetadata, finishedAt: Number.POSITIVE_INFINITY }],
    ["a non-boolean truncation flag", { ...validMetadata, patchTruncated: "yes" }],
    ["an unknown verdict", { ...validMetadata, verdict: "maybe" }],
    ["an unknown severity", { ...validMetadata, highestSeverity: "blocker" }],
    ["an unknown reason", { ...validMetadata, reasons: ["sensitive_path", "made_up"] }],
    ["reasons that are not an array", { ...validMetadata, reasons: "sensitive_path" }],
    ["an empty reason", { ...validMetadata, reasons: [""] }],
    ["an overlong reason", { ...validMetadata, reasons: ["x".repeat(129)] }],
    ["too many reasons", { ...validMetadata, reasons: Array.from({ length: 17 }, () => "sensitive_path") }],
  ])("rejects %s", (_label, value) => {
    expect(readAutoReviewRunMetadata(value)).toBeUndefined();
  });

  it("accepts the maximum bounded reason list", () => {
    const reasons = Array.from({ length: 16 }, () => "sensitive_path");
    const result = readAutoReviewRunMetadata({ ...validMetadata, reasons });
    expect(result?.reasons).toEqual(reasons);
  });
});
