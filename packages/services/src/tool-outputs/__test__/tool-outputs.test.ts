import { describe, it, expect, afterEach } from "vitest";
import {
  toolOutputInlineChars,
  toolOutputPreviewChars,
  microcompactToolResultChars,
  isMicrocompactableToolResult,
  DEFAULT_TOOL_OUTPUT_INLINE_CHARS,
  DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS,
  DEFAULT_MICROCOMPACT_TOOL_RESULT_CHARS,
} from "../tool-outputs.js";

const ENV_KEYS = [
  "VYKOR_TOOL_OUTPUT_INLINE_CHARS",
  "VYKOR_TOOL_OUTPUT_PREVIEW_CHARS",
  "VYKOR_MICROCOMPACT_TOOL_RESULT_CHARS",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("budget envs", () => {
  it("returns defaults without env overrides", () => {
    expect(toolOutputInlineChars()).toBe(DEFAULT_TOOL_OUTPUT_INLINE_CHARS);
    expect(toolOutputPreviewChars()).toBe(DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS);
    expect(microcompactToolResultChars()).toBe(DEFAULT_MICROCOMPACT_TOOL_RESULT_CHARS);
  });

  it("honors env overrides and clamps to the minimum", () => {
    process.env.VYKOR_TOOL_OUTPUT_INLINE_CHARS = "20000";
    expect(toolOutputInlineChars()).toBe(20000);
    process.env.VYKOR_TOOL_OUTPUT_INLINE_CHARS = "10"; // < minimum 256
    expect(toolOutputInlineChars()).toBe(256);
    process.env.VYKOR_TOOL_OUTPUT_PREVIEW_CHARS = "5"; // < minimum 128
    expect(toolOutputPreviewChars()).toBe(128);
  });

  it("falls back to defaults on invalid env values", () => {
    process.env.VYKOR_MICROCOMPACT_TOOL_RESULT_CHARS = "not-a-number";
    expect(microcompactToolResultChars()).toBe(DEFAULT_MICROCOMPACT_TOOL_RESULT_CHARS);
    process.env.VYKOR_MICROCOMPACT_TOOL_RESULT_CHARS = "";
    expect(microcompactToolResultChars()).toBe(DEFAULT_MICROCOMPACT_TOOL_RESULT_CHARS);
  });
});

describe("isMicrocompactableToolResult", () => {
  it("MCP tool results are always microcompactable", () => {
    expect(isMicrocompactableToolResult("mcp__db__query", "tiny")).toBe(true);
    expect(isMicrocompactableToolResult("  mcp__x ", "tiny")).toBe(true);
  });

  it("non-MCP results depend on the size threshold", () => {
    expect(isMicrocompactableToolResult("Bash", "short output")).toBe(false);
    expect(isMicrocompactableToolResult("Bash", "x".repeat(DEFAULT_MICROCOMPACT_TOOL_RESULT_CHARS))).toBe(true);
  });
});
