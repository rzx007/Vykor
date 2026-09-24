import { describe, it, expect } from "vitest";
import { AuthenticationFailure, RateLimitFailure, RequestFailure } from "@vykor/api";
import { formatApiError } from "./format-error";
import type { Settings } from "@vykor/core";

const SETTINGS: Settings = {
  model: "minimax/minimax-m2.5:free",
  apiFormat: "openai",
  provider: "openrouter",
  maxTurns: 50,
  permission: { mode: "default" },
};

describe("formatApiError", () => {
  it("formats AuthenticationFailure with guidance", () => {
    const err = new AuthenticationFailure("401 Missing Authentication header");
    const msg = formatApiError(err, SETTINGS);
    expect(msg).toContain("Authentication failed (401)");
    expect(msg).toContain("openrouter");
    expect(msg).toContain("minimax/minimax-m2.5:free");
    expect(msg).toContain("/auth login");
  });

  it("formats Codex AuthenticationFailure with auth login codex guidance", () => {
    const err = new AuthenticationFailure("401 Missing Authentication header");
    const msg = formatApiError(err, { ...SETTINGS, provider: "codex", model: "gpt-5.4" });
    expect(msg).toContain("Codex subscription auth is not ready");
    expect(msg).toContain("/auth login codex");
  });

  it("formats RateLimitFailure as rate limit message", () => {
    const err = new RateLimitFailure("429 Too many requests");
    const msg = formatApiError(err, SETTINGS);
    expect(msg).toContain("Rate limit hit (429)");
    expect(msg).toContain("wait a moment");
  });

  it("formats RateLimitFailure as quota exceeded when quota keywords present", () => {
    const err = new RateLimitFailure("429 You have exceeded your quota");
    const msg = formatApiError(err, SETTINGS);
    expect(msg).toContain("quota exceeded");
    expect(msg).toContain("billing dashboard");
  });

  it("formats RateLimitFailure as quota for 'insufficient'", () => {
    const err = new RateLimitFailure("Insufficient balance");
    const msg = formatApiError(err, SETTINGS);
    expect(msg).toContain("quota exceeded");
  });

  it("formats RequestFailure with status code", () => {
    const err = new RequestFailure("Server error", 500);
    const msg = formatApiError(err, SETTINGS);
    expect(msg).toContain("API request failed (500)");
    expect(msg).toContain("Server error");
  });

  it("passes through generic Error message", () => {
    const err = new Error("Something unexpected");
    const msg = formatApiError(err, SETTINGS);
    expect(msg).toBe("Something unexpected");
  });

  it("uses 'auto' when provider is not set", () => {
    const settings = { ...SETTINGS, provider: undefined };
    const err = new AuthenticationFailure("401 Unauthorized");
    const msg = formatApiError(err, settings);
    expect(msg).toContain("Current provider: auto");
  });
});
