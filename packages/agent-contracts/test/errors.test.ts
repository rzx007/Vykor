import { describe, expect, it } from "vitest";
import { ModelRequestFailure } from "../src/index.js";

describe("ModelRequestFailure", () => {
  it("recognizes the existing global brand across separately loaded bundles", () => {
    const foreign = { [Symbol.for("@vykor/core/ModelRequestFailure")]: true };
    expect(foreign instanceof ModelRequestFailure).toBe(true);
    expect(new Error("unbranded") instanceof ModelRequestFailure).toBe(false);
  });

  it("preserves the original cause and structured info", () => {
    const cause = new Error("socket closed");
    const error = new ModelRequestFailure(
      "connection reset",
      { kind: "network", phase: "stream", retryable: true, statusCode: 503 },
      cause,
    );
    expect(error.name).toBe("ModelRequestFailure");
    expect(error.info).toEqual({
      kind: "network",
      phase: "stream",
      retryable: true,
      statusCode: 503,
    });
    expect(error.cause).toBe(cause);
  });
});
