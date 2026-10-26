import { describe, expect, it } from "vitest";
import type { Message } from "@vykor/agent-contracts";
import { appendContinuityExcerpts, splitOwnedContinuity } from "../compact-continuity.js";

function excerpts(content: string): { entries: Record<string, unknown>[]; omitted: boolean } {
  return JSON.parse(content.split("\n").at(-1)!.slice("[history-excerpts-v1]".length));
}

describe("continuation source facts", () => {
  it("keeps unknown and not-started outcomes distinct from completed observations after repeated compaction", () => {
    const history: Message[] = [
      { type: "user", content: "目标：生成报告；发布前先让我确认。" },
      { type: "assistant", content: "计划发布；尚未确认完成。", toolUses: [
        { type: "tool_use", id: "send", name: "SendReport", input: {} },
        { type: "tool_use", id: "skipped", name: "Write", input: {} },
      ] },
      { type: "tool_result", toolUseId: "send", content: [{ type: "text", text: "连接断开" }], executionState: "unknown", isError: true },
      { type: "tool_result", toolUseId: "skipped", content: [{ type: "text", text: "未执行" }], executionState: "not_started", isError: true },
    ];
    const first = appendContinuityExcerpts("模型摘要声称：报告已经发布。", history);
    const twice = appendContinuityExcerpts("第二次摘要同样可能有误。", [{ type: "assistant", content: first, compactRole: "summary" }]);
    expect(excerpts(twice).entries).toEqual([
      { source: "user", order: 1, text: "目标：生成报告；发布前先让我确认。" },
      { source: "tool_result", order: 3, text: "连接断开", toolUseId: "send", toolName: "SendReport", executionState: "unknown", isError: true },
      { source: "tool_result", order: 4, text: "未执行", toolUseId: "skipped", toolName: "Write", executionState: "not_started", isError: true },
    ]);
  });

  it("keeps a durable full-result reference even when a trusted short summary omits it", () => {
    const content = appendContinuityExcerpts("已生成产物，下一步核验。", [
      { type: "assistant", content: "", toolUses: [{ type: "tool_use", id: "build", name: "Build", input: {} }] },
      { type: "tool_result", toolUseId: "build", content: [{ type: "text", text: "truncated output" }],
        compactSummary: "产物路径：dist/report.html", executionState: "completed", isError: false,
        resultRef: { id: "result:operation_build:attempt_build", toolName: "Build", totalChars: 300004 } },
    ]);
    const repeated = appendContinuityExcerpts("再次压缩。", [{ type: "assistant", content, compactRole: "summary" }]);
    expect(excerpts(repeated).entries).toEqual([{
      source: "tool_result", order: 2, text: "产物路径：dist/report.html", toolUseId: "build", toolName: "Build",
      executionState: "completed", isError: false,
      resultRef: { id: "result:operation_build:attempt_build", toolName: "Build", totalChars: 300004 },
    }]);
  });

  it("reads legacy excerpts without inventing an execution outcome", () => {
    const legacy = 'summary\n[history-excerpts-v1]{"entries":[{"source":"tool_result","order":1,"text":"old output","toolUseId":"old","toolName":"OldTool"}],"omitted":false}';
    const content = appendContinuityExcerpts("new summary", [{ type: "assistant", content: legacy, compactRole: "summary" }]);
    expect(excerpts(content).entries).toEqual([{ source: "tool_result", order: 1, text: "old output", toolUseId: "old", toolName: "OldTool" }]);
    expect(splitOwnedContinuity({ type: "assistant", compactRole: "summary", content })?.container).toContain("old output");
  });

  it("preserves a non-text result reference even when no prose can be excerpted", () => {
    const content = appendContinuityExcerpts("生成了图片。", [
      { type: "assistant", content: "", toolUses: [{ type: "tool_use", id: "image", name: "Render", input: {} }] },
      { type: "tool_result", toolUseId: "image", content: [], executionState: "completed",
        resultRef: { id: "result:image", toolName: "Render", totalChars: 24 } },
    ]);
    expect(excerpts(content).entries).toEqual([{
      source: "tool_result", order: 2, text: "", toolUseId: "image", toolName: "Render", executionState: "completed",
      resultRef: { id: "result:image", toolName: "Render", totalChars: 24 },
    }]);
  });
});
