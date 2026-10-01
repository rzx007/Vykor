import { describe, expect, it } from "vitest";

import {
  parseRetryAfterMs,
  ProviderCapabilityMismatchFailure,
  RequestFailure,
  requestFailure,
  toModelRequestFailure,
} from "./index.js";

describe("requestFailure", () => {
  it("classifies an explicit provider image rejection", () => {
    const error = requestFailure("This model does not support image input", 400);
    expect(error).toBeInstanceOf(ProviderCapabilityMismatchFailure);
    expect(error).toMatchObject({ code: "provider_capability_mismatch", statusCode: 400 });
  });

  it("keeps unrelated bad requests generic", () => {
    expect(requestFailure("Invalid temperature", 400)).toBeInstanceOf(RequestFailure);
    expect(requestFailure("Invalid temperature", 400)).not.toBeInstanceOf(
      ProviderCapabilityMismatchFailure,
    );
  });
});
describe("toModelRequestFailure", () => {
  const terminated = "Upstream stream terminated unexpectedly before completion";

  it("recognizes the upstream termination message only while consuming a stream", () => {
    expect(toModelRequestFailure(new Error(terminated), "stream").info)
      .toMatchObject({ kind: "stream_incomplete", phase: "stream", retryable: true });
    expect(toModelRequestFailure(new Error(terminated), "request").info.retryable).toBe(false);
    expect(toModelRequestFailure(new Error("Example: " + terminated), "stream").info.retryable).toBe(false);
  });

  it("recognizes an upstream termination inside a wrapped SDK error", () => {
    const original = new Error("SDK stream failed", { cause: new Error(terminated) });
    const failure = toModelRequestFailure(original, "stream");
    expect(failure.info).toMatchObject({ kind: "stream_incomplete", retryable: true });
    expect(failure.cause).toBe(original);
  });

  it("uses the original stream error message when a provider decorates the display message", () => {
    const failure = toModelRequestFailure({
      message: terminated + " (code=gateway_error)", error: { code: "gateway_error", message: terminated },
    }, "stream");
    expect(failure.info).toMatchObject({ kind: "stream_incomplete", retryable: true });
  });

  it("does not retry a structured certificate error even when its type is server_error", () => {
    const failure = toModelRequestFailure({
      message: terminated, error: { code: "CERT_HAS_EXPIRED", type: "server_error" },
    }, "stream");
    expect(failure.info).toMatchObject({ kind: "network", retryable: false });
  });

  it.each([
    ["server_error", "server"], ["api_error", "server"], ["overloaded_error", "server"],
    ["server_is_overloaded", "server"], ["rate_limit_exceeded", "rate_limit"],
    ["rate_limit_error", "rate_limit"], ["timeout_error", "timeout"],
    ["upstream_stream_error", "stream_incomplete"],
  ])("recognizes a mid-stream %s without an HTTP error status", (code, kind) => {
    const error = Object.assign(new Error("provider error"), {
      error: { code }, headers: { "retry-after": "7", "x-request-id": "req-stream" },
    });
    expect(toModelRequestFailure(error, "stream").info).toMatchObject({
      kind, retryable: true, phase: "stream", retryAfterMs: 7_000, requestId: "req-stream",
    });
  });

  it("reads both the error code and type when the code alone is unknown", () => {
    const error = { message: "provider error", error: { code: "gateway_specific", type: "overloaded_error" } };
    expect(toModelRequestFailure(error, "stream").info).toMatchObject({ kind: "server", retryable: true });
  });

  it("retries HTTP 408 request timeouts", () => {
    expect(toModelRequestFailure({ message: "timed out", status: 408 }, "request").info)
      .toMatchObject({ kind: "timeout", phase: "request", retryable: true, statusCode: 408 });
  });

  it.each([
    ["authentication_error", "authentication"], ["permission_error", "authentication"],
    ["insufficient_quota", "quota"], ["billing_error", "quota"], ["usage_limit_reached", "quota"],
    ["credit_balance_exhausted", "quota"], ["invalid_request", "invalid_request"],
    ["context_length_exceeded", "invalid_request"], ["content_policy_violation", "invalid_request"],
  ])("does not override permanent %s errors with a retryable stream message", (code, kind) => {
    const error = { message: terminated, error: { code, type: "server_error" } };
    expect(toModelRequestFailure(error, "stream").info).toMatchObject({ kind, retryable: false });
  });

  it.each([400, 401, 403, 404, 409])("does not override HTTP %s with transient event codes", (status) => {
    expect(toModelRequestFailure({ message: terminated, status, error: { code: "server_error" } }, "stream").info.retryable)
      .toBe(false);
  });

  it("preserves a nested network cause without an HTTP status", () => {
    const cause = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    const original = new TypeError("fetch failed", { cause });
    const failure = toModelRequestFailure(original, "stream", 0);
    expect(failure.info).toMatchObject({ kind: "network", phase: "stream", retryable: true });
    expect(failure.cause).toBe(original);
  });

  it("classifies auth and invalid request failures as non-retryable", () => {
    const auth = toModelRequestFailure(
      Object.assign(new Error("unauthorized"), { status: 401 }),
      "request",
    );
    expect(auth.info).toMatchObject({ kind: "authentication", retryable: false, statusCode: 401 });

    const invalid = toModelRequestFailure(
      Object.assign(new Error("bad model"), { status: 404 }),
      "request",
    );
    expect(invalid.info).toMatchObject({ kind: "invalid_request", retryable: false });
  });

  it("classifies 5xx as retryable server failures", () => {
    const failure = toModelRequestFailure(
      Object.assign(new Error("bad gateway"), { status: 502 }),
      "request",
    );
    expect(failure.info).toMatchObject({ kind: "server", retryable: true, statusCode: 502 });
  });

  it("does not retry exhausted quota 429s", () => {
    const failure = toModelRequestFailure(
      Object.assign(new Error("quota"), { status: 429, code: "insufficient_quota" }),
      "request",
    );
    expect(failure.info).toMatchObject({ kind: "quota", retryable: false, statusCode: 429 });
  });

  it("honors a Retry-After header on 429", () => {
    const failure = toModelRequestFailure(
      Object.assign(new Error("rate limited"), {
        status: 429,
        headers: { get: (name: string) => (name === "retry-after" ? "12" : undefined) },
      }),
      "request",
      0,
    );
    expect(failure.info).toMatchObject({ kind: "rate_limit", retryable: true, retryAfterMs: 12_000 });
  });

  it("does not classify certificate errors as retryable", () => {
    const failure = toModelRequestFailure(
      Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      "request",
    );
    expect(failure.info.retryable).toBe(false);
  });

  it("does not classify arbitrary programming errors as retryable", () => {
    const failure = toModelRequestFailure(new TypeError("cannot read properties of undefined"), "request");
    expect(failure.info.retryable).toBe(false);
    expect(failure.info.kind).toBe("unknown");
  });
});

describe("parseRetryAfterMs", () => {
  it("parses seconds", () => {
    expect(parseRetryAfterMs("5")).toBe(5_000);
    expect(parseRetryAfterMs(2)).toBe(2_000);
  });

  it("parses an HTTP date relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const when = new Date(now + 30_000).toUTCString();
    expect(parseRetryAfterMs(when, now)).toBe(30_000);
  });

  it("ignores negative and invalid values", () => {
    expect(parseRetryAfterMs("-3")).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });
});
