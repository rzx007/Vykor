import { expect, it } from "vitest";
import { summarizePart, summarizePartEvent } from "./part-wire-view.js";
import type { SessionMessagePartRecord } from "@vykor/protocol";
import { formatWorkflowNotification } from "@vykor/coordinator";

it("preserves Workflow action and run identity when a synchronous result is reduced to a preview", () => {
  const notification = formatWorkflowNotification({ runId: "sync-run", status: "completed", summary: "done", mode: "parallel", totalTasks: 1, completedTasks: 1, failedTasks: 0, needsReconciliation: false, reconciliationIssues: [], reconciliationSummary: { totalIssues: 0, actualConflicts: 0, declaredScopeOverlaps: 0, files: [], tasks: [] }, reconciliationPlan: { needed: false, summary: "", actions: [] }, budget: { tasks: {} }, tasks: [{ taskId: "a", status: "completed", summary: "done", result: "x".repeat(8000), attempts: 1, dependencies: [], startedAt: 1, finishedAt: 2 }] });
  const summary = summarizePart({ ...part, toolName: "Workflow", input: { action: "resume", prompt: "x".repeat(8000) }, output: { content: [{ type: "text", text: notification }] } });
  expect(summary.bodyView).toMatchObject({ input: "preview", output: "preview" });
  expect(summary.input?.action).toBe("resume");
  expect(summary.metadata.workflowRunId).toBe("sync-run");
  expect(JSON.stringify(summary)).not.toContain("x".repeat(1000));
});

const part: SessionMessagePartRecord = { id: "p", sessionId: "s", messageId: "m", seq: 1, type: "tool", toolName: "UnknownTool", status: "failed", isError: true, input: { hidden: "x".repeat(20_000) }, output: { content: [{ type: "text", text: "failure".repeat(3000) + " shell-output://00000000-0000-4000-8000-000000000001" }], isError: true, failureKind: "command", executionState: "completed", recoveryHint: "inspect log" }, metadata: { failureKind: "command", executionState: "completed", pluginUi: { id: "business-ui" } }, createdAt: 1, updatedAt: 1 };

it("preserves known file-tool identities inside accepted single-field input envelopes", () => {
  for (const wrapper of ["arguments", "args", "parameters"]) {
    const input = { [wrapper]: { file_path: "C:/work/result.txt", content: "x".repeat(5000) } };
    const summary = summarizePart({ ...part, toolName: "Write", input });
    expect(summary.input?.[wrapper]).toEqual({ file_path: "C:/work/result.txt" });
    expect(summary.bodyView?.input).toBe("preview");
    expect(input[wrapper]?.content).toHaveLength(5000);
  }
  const mixed = summarizePart({ ...part, toolName: "Write", input: { file_path: "root.txt", content: "x".repeat(5000), arguments: { file_path: "nested.txt" } } });
  expect(mixed.input).toEqual({ file_path: "root.txt" });
  const business = summarizePart({ ...part, input: { arguments: { file_path: "business.txt", content: "x".repeat(5000) } } });
  expect(business.input).toEqual({});
});

it("bounds unknown tool bodies without claiming empty arguments are complete and preserves diagnostics and references", () => {
  const summary = summarizePart(part);
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(4096);
  expect(summary.bodyView).toEqual({ input: "preview", output: "preview", outputReferences: ["shell-output://00000000-0000-4000-8000-000000000001"] });
  expect(summary).toMatchObject({ status: "failed", isError: true, metadata: part.metadata, output: { failureKind: "command", executionState: "completed", recoveryHint: "inspect log" } });
  expect(part.input?.hidden).toHaveLength(20_000);
  expect(summarizePart({ ...part, input: {}, output: undefined }).bodyView).toEqual({ input: "full", output: "unavailable" });
  const unknownResult = summarizePart({ ...part, output: { data: "opaque-result".repeat(1000) } });
  expect(unknownResult.output).toMatchObject({ content: [{ text: expect.stringContaining("opaque-result") }] });
  expect(unknownResult.bodyView?.output).toBe("preview");
});

it("projects transcript replacement with the same summary meaning while leaving unrelated events alone", () => {
  const event = { id: "e", seq: 1, schemaVersion: 1, type: "session.transcript.replaced", sessionId: "s", payload: { messages: [], parts: [part] }, createdAt: 1 };
  expect((summarizePartEvent(event).payload.parts as SessionMessagePartRecord[])[0]?.bodyView?.input).toBe("preview");
  expect(event.payload.parts[0]?.input?.hidden).toHaveLength(20_000);
  const ordinary = { ...event, type: "session.status.updated" };
  expect(summarizePartEvent(ordinary)).toBe(ordinary);
});

it("retains original short Shell retention notices without admitting long bodies through a notice prefix", () => {
  const notice = "Shell 日志不完整，已收到的内容仍可补读。 使用 Read(file_path=\"shell-output://00000000-0000-4000-8000-000000000001\", cursor=0)。";
  const summary = summarizePart({ ...part, toolName: "Shell", output: { content: [{ type: "text", text: "body".repeat(3000) }, { type: "text", text: notice }, { type: "text", text: "Shell 日志" + "evil".repeat(3000) }] } });
  expect(summary.output).toMatchObject({ content: [{ text: "body".repeat(128) }, { text: notice }] });
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(4096);
});

it("retains bounded Agent created-job identity as valid JSON when a legal long label makes output previewed", () => {
  const summary = summarizePart({ ...part, toolName: "Agent", output: { content: [{ type: "text", text: JSON.stringify({ kind: "job", action: "created", jobId: "job-real", jobKind: "agent", label: "description".repeat(500) }) }] } });
  const output = summary.output as { content: Array<{ text: string }> };
  expect(JSON.parse(output.content[0]!.text)).toMatchObject({ kind: "job", action: "created", jobId: "job-real", jobKind: "agent" });
  expect(summary.bodyView?.output).toBe("preview");
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(4096);
});

it("retains validated ImageGeneration ratios beside previewed prompts and inline images", () => {
  const summary = summarizePart({ ...part, toolName: "ImageGeneration", input: { prompt: "p".repeat(5000), image: "data:image/png;base64," + "x".repeat(5000), ratio: "16:9" } });
  expect(summary.input?.ratio).toBe("16:9");
  expect(summary.bodyView?.input).toBe("preview");
  expect(summarizePart({ ...part, toolName: "ImageGeneration", input: { prompt: "p".repeat(5000), ratio: "invalid-ratio" } }).input).not.toHaveProperty("ratio");
});
