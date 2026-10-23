import { afterEach, describe, expect, it, vi } from "vitest";
import { readToolExecutionTimeoutMs, readToolOutputPolicy } from "../tool-output-policy.js";

afterEach(() => vi.unstubAllEnvs());

describe("host tool output configuration", () => {
  it("resolves the existing defaults when settings are absent or invalid", () => {
    vi.stubEnv("VYKOR_TOOL_OUTPUT_INLINE_CHARS", "");
    vi.stubEnv("VYKOR_TOOL_OUTPUT_PREVIEW_CHARS", "invalid");
    vi.stubEnv("VYKOR_TOOL_TIMEOUT_MS", "1.5");
    expect(readToolOutputPolicy()).toEqual({ inlineChars: 16_000, previewChars: 3_000 });
    expect(readToolExecutionTimeoutMs()).toBe(300_000);
  });

  it("applies host values and keeps bounded minimums", () => {
    vi.stubEnv("VYKOR_TOOL_OUTPUT_INLINE_CHARS", " 9000 ");
    vi.stubEnv("VYKOR_TOOL_OUTPUT_PREVIEW_CHARS", "-1");
    vi.stubEnv("VYKOR_TOOL_TIMEOUT_MS", "0");
    expect(readToolOutputPolicy()).toEqual({ inlineChars: 9000, previewChars: 128 });
    expect(readToolExecutionTimeoutMs()).toBe(1);
  });

  it("gives a valid explicit timeout precedence over the environment", () => {
    vi.stubEnv("VYKOR_TOOL_TIMEOUT_MS", "42000");
    expect(readToolExecutionTimeoutMs(7000)).toBe(7000);
    expect(readToolExecutionTimeoutMs(-1)).toBe(42000);
    expect(readToolExecutionTimeoutMs(Number.NaN)).toBe(42000);
  });
});
