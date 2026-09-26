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
