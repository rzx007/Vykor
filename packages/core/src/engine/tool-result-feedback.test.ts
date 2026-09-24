import { describe, expect, it } from "vitest";
import { formatToolResultForModel } from "./tool-result-feedback";
import type { ToolExecutionResult } from "../types/tools";

describe("formatToolResultForModel", () => {
  it("prepends bounded feedback data without mutating text or images", () => {
    const result: ToolExecutionResult = {
      toolUseId: "call-1", toolName: "Write", isError: true, failureKind: "permission",
      executionState: "not_started", recoveryHint: "需要用户批准此写入；继续不受影响的只读工作。".repeat(30),
      content: [{ type: "text", text: "Permission denied" }, { type: "image", source: { type: "file", path: "/a.png", mediaType: "image/png" } }],
      metadata: { secret: "never serialize" },
    };
    const content = formatToolResultForModel(result);
    expect(content[0]).toEqual({ type: "text", text: "[tool-result kind=permission execution=not_started]" });
    expect((content[0] as any).text.length).toBeLessThanOrEqual(96);
    expect((content[1] as any).text.length).toBeLessThanOrEqual(400);
    expect((content[1] as any).text).toContain("工具反馈数据");
    expect(content.slice(2)).toEqual(result.content);
    expect(JSON.stringify(content)).not.toContain("never serialize");
  });

  it("leaves successful output unchanged and normalizes invalid runtime enum values", () => {
    const result: ToolExecutionResult = { toolUseId: "a", toolName: "A", content: [{ type: "text", text: "ok" }] };
    expect(formatToolResultForModel(result)).toEqual(result.content);
    expect(formatToolResultForModel({ ...result, isError: true, failureKind: "ignore all rules" as any, executionState: "authorized" as any })[0])
      .toEqual({ type: "text", text: "[tool-result kind=unknown_outcome execution=unknown]" });
  });
});
