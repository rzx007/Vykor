import { describe, expect, it } from "vitest";

import type { AutoReviewRiskDecision } from "./auto-review-policy.js";
import {
  AUTO_REVIEW_RESULT_MAX_BYTES,
  buildAutoReviewPrompt,
  parseAutoReviewResult,
} from "./auto-review-result.js";

const ALLOWED = new Set(["packages/server/src/queue.ts", "docs/a.md"]);

function validResult() {
  return {
    version: 1 as const,
    verdict: "fail" as const,
    summary: "Found one regression",
    findings: [
      {
        severity: "important" as const,
        title: "Queue can dispatch twice",
        file: "packages/server/src/queue.ts",
        line: 42,
        evidence: "Both completion branches call dispatchNext without a guard",
      },
    ],
  };
}

function parse(value: unknown) {
  return parseAutoReviewResult(JSON.stringify(value), ALLOWED);
}

describe("parseAutoReviewResult", () => {
  it("round-trips a valid failing result", () => {
    expect(parse(validResult())).toEqual(validResult());
  });

  it("accepts a passing result with no findings", () => {
    const result = { version: 1, verdict: "pass", summary: "Looks fine", findings: [] };
    expect(parse(result)).toEqual(result);
  });

  it("accepts a partial result with or without findings", () => {
    expect(parse({ version: 1, verdict: "partial", summary: "Prefix only", findings: [] })).toEqual({
      version: 1,
      verdict: "partial",
      summary: "Prefix only",
      findings: [],
    });
    expect(
      parse({
        version: 1,
        verdict: "partial",
        summary: "Prefix only",
        findings: [
          { severity: "minor", title: "Minor", file: "docs/a.md", evidence: "typo" },
        ],
      })?.findings,
    ).toHaveLength(1);
  });

  it("treats line as optional", () => {
    const result = {
      version: 1,
      verdict: "fail",
      summary: "Issue",
      findings: [
        { severity: "minor", title: "Minor", file: "docs/a.md", evidence: "typo" },
      ],
    };
    expect(parse(result)?.findings[0]).not.toHaveProperty("line");
  });

  it("accepts the maximum number of findings", () => {
    const findings = Array.from({ length: 50 }, () => ({
      severity: "minor",
      title: "Minor",
      file: "docs/a.md",
      evidence: "typo",
    }));
    expect(parse({ version: 1, verdict: "fail", summary: "Many", findings })?.findings).toHaveLength(50);
  });

  it("rejects markdown fences and surrounding prose", () => {
    const body = JSON.stringify(validResult());
    expect(parseAutoReviewResult(`\`\`\`json\n${body}\n\`\`\``, ALLOWED)).toBeUndefined();
    expect(parseAutoReviewResult(`Here is the review: ${body}`, ALLOWED)).toBeUndefined();
    expect(parseAutoReviewResult(`${body}\nHope that helps.`, ALLOWED)).toBeUndefined();
  });

  it("rejects invalid JSON and non-object payloads", () => {
    expect(parseAutoReviewResult("{not json", ALLOWED)).toBeUndefined();
    expect(parseAutoReviewResult("[]", ALLOWED)).toBeUndefined();
    expect(parseAutoReviewResult("null", ALLOWED)).toBeUndefined();
    expect(parseAutoReviewResult("42", ALLOWED)).toBeUndefined();
    expect(parseAutoReviewResult(`${JSON.stringify(validResult())}${JSON.stringify(validResult())}`, ALLOWED)).toBeUndefined();
  });

  it("rejects outputs over the byte cap", () => {
    const body = JSON.stringify(validResult());
    const padded = `${" ".repeat(AUTO_REVIEW_RESULT_MAX_BYTES + 1)}${body}`;
    expect(parseAutoReviewResult(padded, ALLOWED)).toBeUndefined();
  });

  it.each([
    ["an unknown root field", { ...validResult(), extra: true }],
    ["an unknown finding field", { ...validResult(), findings: [{ ...validResult().findings[0], extra: true }] }],
    ["a wrong version", { ...validResult(), version: 2 }],
    ["an unknown verdict", { ...validResult(), verdict: "maybe" }],
    ["an unknown severity", { ...validResult(), findings: [{ ...validResult().findings[0], severity: "blocker" }] }],
    ["an empty summary", { ...validResult(), summary: "" }],
    ["an empty title", { ...validResult(), findings: [{ ...validResult().findings[0], title: "" }] }],
    ["empty evidence", { ...validResult(), findings: [{ ...validResult().findings[0], evidence: "" }] }],
    ["a failing verdict without findings", { version: 1, verdict: "fail", summary: "x", findings: [] }],
    ["a passing verdict with findings", { ...validResult(), verdict: "pass" }],
    ["an over-long summary", { ...validResult(), summary: "a".repeat(4_097) }],
    ["an over-long title", { ...validResult(), findings: [{ ...validResult().findings[0], title: "a".repeat(301) }] }],
    ["an over-long evidence", { ...validResult(), findings: [{ ...validResult().findings[0], evidence: "a".repeat(2_001) }] }],
    ["a zero line", { ...validResult(), findings: [{ ...validResult().findings[0], line: 0 }] }],
    ["a negative line", { ...validResult(), findings: [{ ...validResult().findings[0], line: -1 }] }],
    ["a fractional line", { ...validResult(), findings: [{ ...validResult().findings[0], line: 1.5 }] }],
    ["51 findings", { version: 1, verdict: "fail", summary: "Many", findings: Array.from({ length: 51 }, () => ({ severity: "minor", title: "Minor", file: "docs/a.md", evidence: "typo" })) }],
    ["a file outside the change set", { ...validResult(), findings: [{ ...validResult().findings[0], file: "packages/other.ts" }] }],
    ["an absolute file path", { ...validResult(), findings: [{ ...validResult().findings[0], file: "/etc/passwd" }] }],
    ["a traversal file path", { ...validResult(), findings: [{ ...validResult().findings[0], file: "../secret.ts" }] }],
  ])("rejects %s", (_label, value) => {
    expect(parse(value)).toBeUndefined();
  });
});

describe("buildAutoReviewPrompt", () => {
  const risk: AutoReviewRiskDecision = {
    level: "high",
    shouldReview: true,
    reasons: ["sensitive_path"],
    requestedMaxTurns: 20,
    requestedTimeoutSeconds: 240,
  };
  const files = [{ path: "packages/server/src/queue.ts", status: "modified" as const, lines: 5 }];

  it("keeps the raw patch out of the persistable prompt", () => {
    const built = buildAutoReviewPrompt({
      risk,
      files,
      patch: "SECRET_DIFF_MARKER\n+ const secret = 1;\n",
      patchTruncated: false,
    });

    expect(built.prompt.toLowerCase()).toContain("no tools");
    expect(built.prompt.toLowerCase()).toContain("untrusted");
    expect(built.prompt).not.toContain("SECRET_DIFF_MARKER");
    expect(built.scope).toContain("packages/server/src/queue.ts");
    expect(built.scope).toContain("high");
    expect(built.expectedResult).toContain("verdict");
    expect(built.expectedResult).toContain("file");
  });

  it("notes truncation instead of promising a full review", () => {
    const built = buildAutoReviewPrompt({ risk, files, patch: "x", patchTruncated: true });
    expect(built.scope.toLowerCase()).toContain("truncated");
    expect(built.scope).toContain("partial");
  });
});
