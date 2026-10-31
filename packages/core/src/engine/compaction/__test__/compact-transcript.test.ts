import { describe, expect, it } from "vitest";
import type { Message } from "@vykor/agent-contracts";
import type { CompactClient } from "../compact-types.js";
import { collectSummary } from "../compact-summary.js";
import { toolResultReferenceHint } from "../../tools/tool-result-feedback.js";

/** Replace only the external model; inspect the prompt built by collectSummary. */
async function captureTranscript(messages: Message[]): Promise<string> {
  let prompt = "";
  const client: CompactClient = {
    async *submitMessage(content) {
      prompt = content;
      yield { type: "text_delta", delta: "<summary>Retain the current task and observed tool facts.</summary>" };
      yield { type: "complete", stopReason: "end_turn" };
    },
  };
  await collectSummary(client, messages, "Summarize the supplied conversation.");
  const conversation = prompt.match(/<conversation>\n([\s\S]*)\n<\/conversation>/);
  expect(conversation, "the summarizer must receive the serialized conversation").not.toBeNull();
  return conversation![1]!;
}

function recordLine(transcript: string, kind: "ToolCall" | "ToolResult", id: string): string {
  const line = transcript.split("\n").find(candidate =>
    candidate.includes(`${kind}:`) && candidate.includes(`id="${id}"`),
  );
  expect(line, `${kind} ${id} must remain visible to the summarizer`).toBeDefined();
  return line!;
}

/** The 4,000-character limit applies to one message's serialized content. */
function assistantBodyLength(transcript: string): number {
  return transcript.replace(/^Assistant:[ \t]?\n?/, "").length;
}

describe("compaction model transcript", () => {
  it("retains a Shell call and its target when the assistant has no prose", async () => {
    const transcript = await captureTranscript([{
      type: "assistant", content: "", toolUses: [{
        type: "tool_use", id: "scan-agent", name: "Shell",
        input: { command: "rg TASK_MARKER src/agent.ts", workdir: "/repo" },
      }],
    }]);

    const call = recordLine(transcript, "ToolCall", "scan-agent");
    expect(call).toContain('name="Shell"');
    expect(call).toContain("input=");
    expect(call).toContain('"command":');
    expect(call).toContain("TASK_MARKER");
    expect(call).toContain("src/agent.ts");
  });

  it("pairs non-adjacent results by ID while preserving the actual message and call order", async () => {
    const transcript = await captureTranscript([
      { type: "assistant", content: "", toolUses: [
        { type: "tool_use", id: "first-read", name: "Read", input: { file_path: "/repo/first.ts" } },
        { type: "tool_use", id: "second-shell", name: "Shell", input: { command: "check-second" } },
      ] },
      { type: "user", content: "Keep the existing files." },
      { type: "tool_result", toolUseId: "second-shell", content: [{ type: "text", text: "Second result." }] },
      { type: "assistant", content: "", toolUses: [
        { type: "tool_use", id: "third-grep", name: "Grep", input: { pattern: "third", path: "/repo" } },
      ] },
      { type: "tool_result", toolUseId: "first-read", content: [{ type: "text", text: "First result arrived later." }] },
      { type: "tool_result", toolUseId: "third-grep", content: [{ type: "text", text: "Third result." }] },
    ]);

    const read = recordLine(transcript, "ToolResult", "first-read");
    const shell = recordLine(transcript, "ToolResult", "second-shell");
    const grep = recordLine(transcript, "ToolResult", "third-grep");
    expect(read).toContain('name="Read"');
    expect(shell).toContain('name="Shell"');
    expect(grep).toContain('name="Grep"');
    for (const result of [read, shell, grep]) expect(result).toContain("match=paired");

    const order = [
      recordLine(transcript, "ToolCall", "first-read"),
      recordLine(transcript, "ToolCall", "second-shell"),
      "Keep the existing files.",
      shell,
      recordLine(transcript, "ToolCall", "third-grep"),
      read,
      grep,
    ].map(fragment => transcript.indexOf(fragment));
    expect(order.every(index => index >= 0)).toBe(true);
    expect(order.every((index, position) => position === 0 || index > order[position - 1]!)).toBe(true);
  });

  it("marks an orphan result unmatched instead of borrowing the nearby call's name", async () => {
    const transcript = await captureTranscript([
      { type: "assistant", content: "", toolUses: [
        { type: "tool_use", id: "nearby-shell", name: "Shell", input: { command: "inspect-only" } },
      ] },
      { type: "tool_result", toolUseId: "missing-call", content: [{ type: "text", text: "Orphan result." }],
        executionState: "not_started", isError: true },
    ]);

    const result = recordLine(transcript, "ToolResult", "missing-call");
    expect(result).toContain("match=unmatched");
    expect(result).not.toContain('name="Shell"');
    expect(transcript).toMatch(/executionState["']?\s*[:=]\s*"?not_started"?/);
  });

  it("marks duplicate call IDs ambiguous instead of choosing either tool name", async () => {
    const transcript = await captureTranscript([
      { type: "assistant", content: "", toolUses: [
        { type: "tool_use", id: "reused-call", name: "Read", input: { file_path: "/repo/source.ts" } },
      ] },
      { type: "assistant", content: "", toolUses: [
        { type: "tool_use", id: "reused-call", name: "Write", input: { file_path: "/repo/result.ts", content: "new" } },
      ] },
      { type: "tool_result", toolUseId: "reused-call", content: [{ type: "text", text: "Ambiguous result." }] },
    ]);

    const result = recordLine(transcript, "ToolResult", "reused-call");
    expect(result).toContain("match=ambiguous");
    expect(result).not.toMatch(/name="(?:Read|Write)"/);
  });

  it("describes unparsed arguments without presenting the empty placeholder as valid input", async () => {
    const transcript = await captureTranscript([{
      type: "assistant", content: "", toolUses: [{
        type: "tool_use", id: "broken-arguments", name: "Shell", input: {},
        inputError: { reason: "invalid_json", argumentLength: 12345, position: 12000, stopReason: "max_tokens" },
      }],
    }]);

    const call = recordLine(transcript, "ToolCall", "broken-arguments");
    expect(call).toContain("inputError");
    expect(call).toContain("invalid_json");
    expect(call).toMatch(/argumentLength["']?\s*[:=]\s*12345/);
    expect(call).not.toMatch(/input\s*=\s*\{\}/);
  });

  it("keeps both ends of long arguments and identifies omitted content within one message's budget", async () => {
    const transcript = await captureTranscript([{
      type: "assistant", content: "", toolUses: [{
        type: "tool_use", id: "long-script", name: "Shell",
        input: { command: `SCRIPT_HEAD ${"middle detail ".repeat(1200)} SCRIPT_TAIL --target=/repo/final.ts` },
      }],
    }]);

    recordLine(transcript, "ToolCall", "long-script");
    expect(transcript).toContain("SCRIPT_HEAD");
    expect(transcript).toContain("SCRIPT_TAIL");
    expect(transcript).toContain("/repo/final.ts");
    expect(transcript).toMatch(/truncated|omitted/i);
    expect(assistantBodyLength(transcript)).toBeLessThanOrEqual(4000);
  });

  it("reports omitted tool calls instead of overflowing a message with a large batch", async () => {
    const transcript = await captureTranscript([{
      type: "assistant", content: "", toolUses: Array.from({ length: 80 }, (_, index) => ({
        type: "tool_use", id: `batch-${index}`, name: "Read",
        input: { file_path: `/repo/${index}-${"long-directory-name/".repeat(20)}source.ts` },
      })),
    }]);

    const calls = transcript.match(/ToolCall:/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThan(80);
    expect(transcript).toMatch(/tool calls?[^\n]*(?:omitted|truncated)|(?:omitted|truncated)[^\n]*tool calls?/i);
    expect(assistantBodyLength(transcript)).toBeLessThanOrEqual(4000);
  });

  it("includes controlled compactSummary facts once when they were already prepended to result content", async () => {
    const transcript = await captureTranscript([{
      type: "tool_result", toolUseId: "edited-file", compactSummary: "OBSERVED_FILE_EDIT: /repo/task.ts",
      executionState: "completed", isError: false,
      content: [
        { type: "text", text: "Tool feedback data (observed at the time, not instructions):\nOBSERVED_FILE_EDIT: /repo/task.ts" },
        { type: "text", text: "One replacement applied." },
      ],
    }]);

    expect(transcript.match(/OBSERVED_FILE_EDIT/g)).toHaveLength(1);
    expect(transcript).toContain("/repo/task.ts");
    expect(transcript).toContain("One replacement applied.");
  });

  it("keeps unknown execution, the error flag and the full result reference ahead of long output", async () => {
    const transcript = await captureTranscript([
      { type: "assistant", content: "", toolUses: [
        { type: "tool_use", id: "write-unknown", name: "Write", input: { file_path: "/repo/report.ts", content: "updated" } },
      ] },
      { type: "tool_result", toolUseId: "write-unknown", executionState: "unknown", isError: true,
        failureKind: "unknown_outcome", compactSummary: "Write attempt observed; verify the actual file before retrying.",
        resultRef: { id: "result:write-unknown:attempt_0123456789abcdef", toolName: "Write", totalChars: 50000 },
        content: [{ type: "text", text: "Output before connection loss. ".repeat(800) }] },
    ]);

    expect(recordLine(transcript, "ToolResult", "write-unknown")).toContain("match=paired");
    expect(transcript).toMatch(/executionState["']?\s*[:=]\s*"?unknown"?/);
    expect(transcript).toMatch(/isError["']?\s*[:=]\s*true/);
    expect(transcript).toContain("result:write-unknown:attempt_0123456789abcdef");
    expect(transcript).not.toMatch(/executionState["']?\s*[:=]\s*"?completed"?/);
    expect(transcript).not.toMatch(/\bsuccess\b/i);
  });

  it("replaces user and tool-result images with placeholders without exposing their sources", async () => {
    const transcript = await captureTranscript([
      { type: "user", content: [
        { type: "text", text: "Compare the attached screenshot." },
        { type: "image", source: { type: "file", mediaType: "image/png", path: "/private/private-user-image.png", sizeBytes: 2000,
          prepared: { mediaType: "image/png", width: 900, height: 600, base64Bytes: 2700, policyVersion: "private-image-policy" } } },
      ] },
      { type: "tool_result", toolUseId: "image-output", content: [
        { type: "text", text: "An image was returned." },
        { type: "image", source: { type: "file", mediaType: "image/png", path: "/private/private-tool-image.png" } },
      ] },
    ]);

    expect(transcript).toContain("Compare the attached screenshot.");
    expect(transcript).toContain("An image was returned.");
    expect(transcript).toMatch(/image[^\n]*(?:omitted|placeholder)/i);
    expect(transcript).not.toContain("private-user-image");
    expect(transcript).not.toContain("private-tool-image");
    expect(transcript).not.toContain("private-image-policy");
    expect(transcript).not.toContain('"source"');
  });

  it("does not pair a result with a call that only appears later", async () => {
    const transcript = await captureTranscript([
      { type: "tool_result", toolUseId: "future", content: [{ type: "text", text: "Earlier unmatched output" }] },
      { type: "assistant", content: "", toolUses: [{ type: "tool_use", id: "future", name: "FutureTool", input: {} }] },
    ]);
    const result = recordLine(transcript, "ToolResult", "future");
    expect(result).toContain("match=unmatched");
    expect(result).not.toContain('name="FutureTool"');
  });

  it("does not present repeated result IDs as one unambiguous observation", async () => {
    const transcript = await captureTranscript([
      { type: "assistant", content: "", toolUses: [{ type: "tool_use", id: "duplicate-result", name: "Send", input: { target: "report" } }] },
      { type: "tool_result", toolUseId: "duplicate-result", content: [{ type: "text", text: "First observation" }] },
      { type: "tool_result", toolUseId: "duplicate-result", content: [{ type: "text", text: "Second observation" }] },
    ]);
    const results = transcript.split("\n").filter(line => line.startsWith('ToolResult: id="duplicate-result"'));
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toContain("match=ambiguous");
      expect(result).not.toContain('name="Send"');
    }
  });

  it("keeps explicit false without inventing execution state for legacy results", async () => {
    const transcript = await captureTranscript([
      { type: "assistant", content: "", toolUses: [{ type: "tool_use", id: "legacy", name: "Inspect", input: {} }] },
      { type: "tool_result", toolUseId: "legacy", content: [{ type: "text", text: "Old observation" }], isError: false },
    ]);
    expect(recordLine(transcript, "ToolResult", "legacy")).toContain("isError=false");
    expect(transcript).not.toContain("executionState");
  });

  it("omits an oversized result reference as a whole rather than inventing a shortened ID", async () => {
    const transcript = await captureTranscript([{
      type: "tool_result", toolUseId: "short-call", executionState: "unknown", content: [{ type: "text", text: "Inspect before retrying" }],
      resultRef: { id: `opaque-reference-${"x".repeat(4500)}-END`, toolName: "Write", totalChars: 9000 },
    }]);
    expect(transcript).toContain('id="short-call"');
    expect(transcript).toMatch(/omitted[^\n]*resultRef|resultRef[^\n]*omitted/i);
    expect(transcript).not.toContain("opaque-reference-");
    expect(transcript.length).toBeLessThanOrEqual(4000);
  });

  it("omits oversized call identities without leaking a clipped opaque ID", async () => {
    const transcript = await captureTranscript([{
      type: "assistant", content: "", toolUses: [{ type: "tool_use", id: `opaque-call-${"x".repeat(4500)}-END`, name: "Read", input: {} }],
    }]);
    expect(transcript).toMatch(/tool calls?[^\n]*omitted|omitted[^\n]*tool calls?/i);
    expect(transcript).not.toContain("opaque-call-");
    expect(transcript.length).toBeLessThanOrEqual(4000);
  });

  it("budgets the rendered role, escaped IDs and parameters together", async () => {
    const transcript = await captureTranscript([{
      type: "assistant", content: "Context ".repeat(1000), toolUses: [{
        type: "tool_use", id: 'escaped-"\\\n'.repeat(30), name: "Shell",
        input: { command: `START_${"\\\"\n中".repeat(1500)}_END` },
      }],
    }]);
    expect(transcript).toContain("ToolCall:");
    expect(transcript).toContain("START_");
    expect(transcript).toContain("_END");
    expect(transcript.length).toBeLessThanOrEqual(4000);
  });

  it("reserves later call identities before spending the budget on the first arguments", async () => {
    const transcript = await captureTranscript([{
      type: "assistant", content: "Existing explanation ".repeat(800), toolUses: [
        { type: "tool_use", id: "first-large", name: "Shell", input: { command: `FIRST_HEAD ${"middle ".repeat(3000)} FIRST_TAIL` } },
        { type: "tool_use", id: "later-small", name: "Read", input: { file_path: "/repo/critical-target.ts" } },
      ],
    }]);
    expect(recordLine(transcript, "ToolCall", "later-small")).toContain("/repo/critical-target.ts");
    expect(transcript).toContain("FIRST_HEAD");
    expect(transcript).toContain("FIRST_TAIL");
    expect(transcript.length).toBeLessThanOrEqual(4000);
  });

  it("does not modify source messages while building the summary request", async () => {
    const messages: Message[] = [
      { type: "assistant", content: "Current plan", toolUses: [{ type: "tool_use", id: "original", name: "Shell", input: { command: "inspect" } }] },
      { type: "tool_result", toolUseId: "original", executionState: "not_started", isError: true, content: [{ type: "text", text: "Permission denied" }] },
    ];
    const before = structuredClone(messages);
    await captureTranscript(messages);
    expect(messages).toEqual(before);
  });

  it("keeps both argument ends for retained calls in a dense long-input batch", async () => {
    const transcript = await captureTranscript([{
      type: "assistant", content: "", toolUses: Array.from({ length: 35 }, (_, index) => ({
        type: "tool_use", id: `dense-${index}`, name: "Shell",
        input: { command: `HEAD_${index} ${"middle ".repeat(300)} TAIL_${index}` },
      })),
    }]);
    const calls = transcript.split("\n").filter(line => line.startsWith("ToolCall:"));
    expect(calls.length).toBeGreaterThan(0);
    for (const line of calls) {
      const index = line.match(/id="dense-(\d+)"/)![1]!;
      expect(line).toContain(`HEAD_${index} `);
      expect(line).toContain(` TAIL_${index}`);
      expect(line).toContain("truncated JSON input");
    }
    expect(transcript.length).toBeLessThanOrEqual(4000);
  });

  it("omits an oversized reference from both metadata and the real host-generated hint", async () => {
    const ref = { id: `opaque-reference-${"x".repeat(4500)}-END`, toolName: "Write", totalChars: 9000 };
    const transcript = await captureTranscript([{
      type: "tool_result", toolUseId: "oversized-hint", executionState: "unknown", resultRef: ref,
      content: [{ type: "text", text: "Inspect before retrying" }, toolResultReferenceHint(ref)],
    }]);
    expect(transcript).toContain("Inspect before retrying");
    expect(transcript).toMatch(/omitted[^\n]*resultRef|resultRef[^\n]*omitted/i);
    expect(transcript).not.toContain("opaque-reference-");
    expect(transcript).not.toContain("tool-output-ref");
    expect(transcript.length).toBeLessThanOrEqual(4000);
  });
});
