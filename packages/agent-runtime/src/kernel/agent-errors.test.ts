import { describe, expect, it } from "vitest";

import {
  AgentOperationConflictError,
  abortError,
  serializeError,
} from "./agent-errors.js";

describe("abortError", () => {
  it("returns the AbortSignal reason when it is an Error", () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    controller.abort(reason);
    expect(abortError(controller.signal)).toBe(reason);
  });

  it("wraps string reasons and returns Error reasons from bare abort", () => {
    const withString = new AbortController();
    withString.abort("caller cancelled");
    expect(abortError(withString.signal)).toEqual(
      expect.objectContaining({ message: "caller cancelled" }),
    );

    const bare = new AbortController();
    bare.abort();
    // Node/DOMAbortSignal uses a DOMException ("This operation was aborted")
    expect(abortError(bare.signal)).toBeInstanceOf(Error);
    expect(abortError(bare.signal).message.length).toBeGreaterThan(0);
  });
});

describe("serializeError", () => {
  it("serializes Error fields and optional code", () => {
    const error = Object.assign(new Error("boom"), { code: "E_TEST" });
    error.stack = "stack-line";
    expect(serializeError(error)).toEqual({
      name: "Error",
      message: "boom",
      code: "E_TEST",
      stack: "stack-line",
    });
  });

  it("stringifies non-Error values", () => {
    expect(serializeError("nope")).toEqual({ name: "Error", message: "nope" });
  });
});

describe("AgentOperationConflictError", () => {
  it("sets a stable name and message", () => {
    const error = new AgentOperationConflictError("a1", "closed", "submitMessage");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AgentOperationConflictError");
    expect(error.message).toContain("closed");
    expect(error.agentId).toBe("a1");
  });
});
