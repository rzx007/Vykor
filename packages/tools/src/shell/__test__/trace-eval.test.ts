import { describe, expect, it } from "vitest";
import baseline from "./fixtures/ai-radar-baseline.json";
import { evaluateShellTrace } from "../trace-eval.js";

describe("evaluateShellTrace", () => {
  it("preserves the observed 34 call / 17 failure baseline", () => {
    expect(evaluateShellTrace(baseline.events)).toMatchObject({
      calls: 34,
      failures: 17,
      repeatedFailureFingerprints: 3,
    });
  });

  it("reports a converged trace", () => {
    expect(evaluateShellTrace([
      { status: "failed", failureFingerprint: "network:7" },
      { status: "completed" },
    ])).toEqual({ calls: 2, failures: 1, repeatedFailureFingerprints: 0 });
  });
});
