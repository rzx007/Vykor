import { describe, expect, it } from "vitest";
import { formatSummary } from "../compact-summary.js";

describe("formatSummary", () => {
  it("formats a single complete non-empty summary", () => {
    expect(formatSummary("<summary>Keep the existing user constraints.</summary>"))
      .toBe("Summary:\nKeep the existing user constraints.");
  });

  it("removes the analysis draft from a valid summary", () => {
    const raw = "<analysis>This draft must not enter retained history.</analysis>\n"
      + "<summary>文件已检查；下一步运行验证。</summary>";

    expect(formatSummary(raw)).toBe("Summary:\n文件已检查；下一步运行验证。");
  });

  it("trims the summary body and collapses excess blank lines", () => {
    const raw = "\n<summary>\n\nKeep the current task.\n\n\n\nNext: verify the result.\n\n</summary>\n";

    expect(formatSummary(raw)).toBe("Summary:\nKeep the current task.\n\nNext: verify the result.");
  });

  // These cases must fail on the previous permissive formatter: accepting them
  // would replace retained history with an absent, partial or ambiguous summary.
  it.each([
    { name: "analysis without a summary", raw: "<analysis>The task needs more thought.</analysis>" },
    { name: "an empty summary", raw: "<summary></summary>" },
    { name: "a whitespace-only summary", raw: "<summary> \n\t\n </summary>" },
    { name: "an empty summary after an analysis draft", raw: "<analysis>Draft only.</analysis><summary> </summary>" },
    { name: "an unclosed summary", raw: "<summary>The retained task is incomplete." },
    { name: "a closing summary tag without an opening tag", raw: "Task state.</summary>" },
    { name: "a complete summary followed by an unclosed summary", raw: "<summary>First task state.</summary><summary>Partial second state." },
    { name: "two complete summaries", raw: "<summary>First task state.</summary>\n<summary>Second task state.</summary>" },
    { name: "a nested summary", raw: "<summary>Outer state.<summary>Inner state.</summary></summary>" },
    { name: "ordinary refusal text", raw: "I cannot summarize this conversation." },
    { name: "empty model output", raw: "" },
  ])("rejects $name", ({ raw }) => {
    expect(() => formatSummary(raw)).toThrow(/summary|摘要/i);
  });
});
