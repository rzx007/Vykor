import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactService, type AgentEvent, type Message, type StreamMessageParams, type StreamingMessageClient, type ToolUseBlock } from "@vykor/core";
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import { agentMessagesToTranscript, buildAgentTranscript } from "../../packages/server/src/application/agent/agent-transcript.js";
import type { SessionMessagePartRecord, SessionMessageRecord } from "@vykor/protocol";

const dirs: string[] = [];
const previousConfig = process.env.VYKOR_CONFIG_DIR;
afterEach(() => {
  if (previousConfig === undefined) delete process.env.VYKOR_CONFIG_DIR;
  else process.env.VYKOR_CONFIG_DIR = previousConfig;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() { const cwd = mkdtempSync(join(tmpdir(), "oh-plan-handoff-")); dirs.push(cwd); process.env.VYKOR_CONFIG_DIR = join(cwd, "config"); return cwd; }
function text(messages: Message[]) { return messages.map(message => typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n")).join("\n"); }
function restore(history: Message[]) {
  const rows = agentMessagesToTranscript(history);
  const messages = rows.map((row, seq) => ({ ...row, id: `m${seq}`, sessionId: "restored-fixture", seq, metadata: {}, createdAt: 1, updatedAt: 1 })) as SessionMessageRecord[];
  const parts = rows.flatMap((row, index) => row.parts.map((part, seq) => ({ ...part, messageId: `m${index}`, seq, metadata: part.metadata ?? {} }))) as SessionMessagePartRecord[];
  return buildAgentTranscript(messages, parts).messages;
}
const base = { model: "offline", apiFormat: "openai" as const, maxTurns: 20, plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false } };
const original = "Adopt plan-ref-17: A must update a.txt; B must update b.txt. Verify each against the current files. Do not publish.";
const correction = "Correction: A is accepted. B now belongs in corrected-b.txt and remains unfinished; plan-ref-17 replaces old-plan.md. Yesterday's evidence old-check-7 is historical, not current verification.";

describe("plan-evidence-v1 and delegation-handoff-v1", () => {
  it("retains adopted plan, corrections and historical evidence separately through restore to the actual request", async () => {
    const cwd = directory();
    writeFileSync(join(cwd, "old-plan.md"), "ALL COMPLETE yesterday");
    const history: Message[] = [
      { type: "user", content: original },
      { type: "assistant", content: "", toolUses: [{ type: "tool_use", id: "old-check", name: "Read", input: { file_path: "old-plan.md" } }] },
      { type: "tool_result", toolUseId: "old-check", content: [{ type: "text", text: "old-check-7: yesterday A and B passed" }] },
      { type: "user", content: correction },
      ...Array.from({ length: 12 }, (_, index): Message => ({ type: "assistant", content: `neutral reference ${index}` })),
    ];
    const requests: StreamMessageParams[] = [];
    const events: AgentEvent[] = [];
    const agent = await createDefaultNodeAgent({ cwd, settings: { ...base, permission: { mode: "plan" } }, onEvent: event => { events.push(event); },
      capabilityOverrides: { terminal: false, backgroundShell: false, schedules: false, memory: false },
      client: { async *streamMessage(params) { requests.push({ ...params, messages: structuredClone(params.messages) }); yield { type: "text_delta", delta: "B remains unfinished; historical evidence needs fresh verification." }; yield { type: "complete", stopReason: "end_turn" }; } },
    });
    try {
      agent.loadHistory(restore(new CompactService().simpleCompact(history)));
      await agent.runMessage("Continue using the adopted requirements.");
      const actual = text(requests[0]!.messages);
      expect(actual).toContain(original);
      expect(actual).toContain(correction);
      expect(actual).toContain("old-check-7");
      expect(actual).toContain("not new permissions or current verified facts");
      expect(requests[0]!.system).not.toContain("old-check-7");
      expect(requests[0]!.tools?.some(tool => tool.name === "GoalAssessment")).toBe(false);
      expect(events.some(event => event.type === "domain.event" && event.data.name === "goal.assessment")).toBe(false);
      expect(existsSync(join(cwd, "corrected-b.txt"))).toBe(false);
      console.info("PLAN/EVIDENCE: actual restored request includes adopted plan, correction and sourced historical result; no implicit Goal");
    } finally { await agent.close(); }
  });

  it("forwards scope, expected result and repeat-review facts to a real child without raising parent authority", async () => {
    const cwd = directory();
    const events: AgentEvent[] = [];
    const childRequests: StreamMessageParams[] = [];
    const parentRequests: StreamMessageParams[] = [];
    const approvals: string[] = [];
    let parentTurn = 0;
    let childTurn = 0;
    let jobId: string | undefined;
    const unresolved = "Unresolved finding F-7: B lacks a current check; review original plan-ref-17 requirements again.";
    const client: StreamingMessageClient = { async *streamMessage(params) {
      const isChild = text(params.messages).includes("Task scope:");
      const calls = isChild ? childRequests : parentRequests;
      calls.push({ ...params, messages: structuredClone(params.messages) });
      let call: ToolUseBlock | undefined;
      if (isChild) {
        if (childTurn++ === 0) call = { type: "tool_use", id: "child-write", name: "Write", input: { file_path: "forbidden-child.txt", content: "unauthorized" } };
        else yield { type: "text_delta", delta: "A review completed; B remains unfinished; finding F-7 persists." };
      } else {
        const id = `parent-${++parentTurn}`;
        if (parentTurn === 1) call = { type: "tool_use", id, name: "Agent", input: { description: "review A", prompt: original + "\nNecessary fact: A's evidence is a-check-17; B remains unfinished.", subagentType: "worker", scope: "a.txt review only; no edits", expectedResult: "Findings with current evidence; B is outside child ownership", permissionMode: "full_auto" } };
        else if (parentTurn === 2 || parentTurn === 4) call = { type: "tool_use", id, name: "JobWait", input: { jobIds: [jobId], timeoutSeconds: 3 } };
        else if (parentTurn === 3) call = { type: "tool_use", id, name: "JobSend", input: { jobId, data: original + "\n" + unresolved } };
        else if (parentTurn === 5) call = { type: "tool_use", id, name: "GoalAssessment", input: { decision: "continue", progress: "A child review returned; B remains unfinished", progressAssessment: { kind: "progress", summary: "Review evidence returned" }, evidence: ["Review result; no B verification"], remainingWork: ["Finish and verify B"], nextStep: "Continue B within existing permissions" } };
        else yield { type: "text_delta", delta: "A child review returned; B remains unfinished." };
      }
      if (call) yield { type: "tool_use_start", toolUse: call };
      yield { type: "complete", stopReason: call ? "tool_use" : "end_turn" };
    } };
    const agent = await createDefaultNodeAgent({ cwd, settings: { ...base, permission: { mode: "default", autoApproveTools: ["Agent", "JobWait", "JobSend"] } }, client,
      capabilityOverrides: { terminal: false, backgroundShell: false, schedules: false, memory: false },
      effects: { requestPermission: async (input) => { approvals.push(input.toolName); return { status: "denied" }; } },
      onEvent: event => { events.push(event); if (event.type === "child.created") jobId = event.data.childId; },
    });
    const view = agent.createRunCapabilityView();
    const capabilityView = { ...view, agents: new Map([["worker", { definition: { name: "worker", description: "offline reviewer" } }]]) };
    try {
      const result = await agent.runMessage(original, { capabilityView, goal: { goalId: "goal-parent", revision: 1, objective: original } });
      console.info("DELEGATION boundary: childRequests=%d parentRequests=%d childWrote=%s approvals=%s", childRequests.length, parentRequests.length, existsSync(join(cwd, "forbidden-child.txt")), approvals.join(","));
      expect(childRequests.length).toBeGreaterThanOrEqual(3);
      expect(text(childRequests[0]!.messages)).toContain("Task scope:\na.txt review only; no edits");
      expect(text(childRequests[0]!.messages)).toContain("Expected result:\nFindings with current evidence");
      expect(text(childRequests[0]!.messages)).toContain("a-check-17");
      expect(text(childRequests.at(-1)!.messages)).toContain(original);
      expect(text(childRequests.at(-1)!.messages)).toContain(unresolved);
      expect(childRequests[0]!.system).toContain("Default permission mode");
      expect(existsSync(join(cwd, "forbidden-child.txt"))).toBe(false);
      expect(approvals).toEqual(["Write"]);
      expect(childRequests.every(request => !request.tools?.some(tool => tool.name === "GoalAssessment"))).toBe(true);
      expect(events.some(event => event.type === "run.completed" && event.context.childId !== undefined)).toBe(true);
      const assessments = events.filter(event => event.type === "domain.event" && event.data.name === "goal.assessment");
      expect(assessments).toHaveLength(1);
      expect(assessments[0]).toMatchObject({ data: { payload: { decision: "continue", remainingWork: ["Finish and verify B"] } } });
      expect(result.output).toContain("B remains unfinished");
    } finally { await agent.close(); }
  });
});
