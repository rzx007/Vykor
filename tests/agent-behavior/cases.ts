import type { AgentEvent, AgentRunResult, Message, StreamingMessageClient, ToolDefinition } from "@vykor/core";
import type { VykorAgent } from "@vykor/agent-runtime";

export interface BehaviorObservation {
  history: Message[];
  events: AgentEvent[];
  runResult?: AgentRunResult;
  finalText: string;
  compacted: boolean;
  requests: readonly { summary: boolean; toolNames: string[]; eventIndex: number }[];
}

export interface BehaviorCase {
  id: string;
  domain: "code" | "research" | "files" | "jobs";
  prompt: string;
  manualChecks?: readonly { id: string; criterion: string }[];
  scripted?(): StreamingMessageClient;
  setup(): {
    tools: ToolDefinition[];
    toolOverrides?: ToolDefinition[];
    deniedTools?: string[];
    run?: (agent: VykorAgent, signal: AbortSignal) => Promise<AgentRunResult>;
    verify(observation: BehaviorObservation): { passed: boolean; reason: string };
  };
}

type Step = { name: string; input?: Record<string, unknown> } | { text: string };

function scripted(steps: Step[], finalText: string): StreamingMessageClient {
  let index = 0;
  return { async *streamMessage(params) {
    if (params.maxTokens === 20_000 && !params.tools) {
      yield { type: "text_delta" as const, delta: "A completed with tool evidence; B remains. Keep job-17 and permission constraints." };
      yield { type: "complete" as const, stopReason: "end_turn" };
      return;
    }
    const step = steps[index++];
    if (step && "name" in step) {
      yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: `step-${index}`, name: step.name, input: step.input ?? {} } };
      yield { type: "complete" as const, stopReason: "tool_use" };
      return;
    }
    yield { type: "text_delta" as const, delta: step && "text" in step ? step.text : finalText };
    yield { type: "complete" as const, stopReason: "end_turn" };
  } };
}

function tool(name: string, execute: ToolDefinition["execute"]): ToolDefinition {
  return { name, description: name, inputSchema: { type: "object" }, execute };
}
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const calls = (observation: BehaviorObservation, name: string) =>
  observation.events.filter((event) => event.type === "tool.started" && event.data.toolUse.name === name).length;

export const behaviorCases: BehaviorCase[] = [
  {
    id: "C1", domain: "code", prompt: "Fix the failing targeted test and verify it.",
    scripted: () => scripted([{ name: "RunTargetTest" }, { name: "PatchFile" }, { name: "RunTargetTest" }], "Targeted test passes; fix complete."),
    setup() { let content = "return false"; let checks = 0; return {
      tools: [
        tool("RunTargetTest", async () => { checks++; return text(content === "return true" ? "exit 0" : "exit 1"); }),
        tool("PatchFile", async () => { content = "return true"; return text("saved"); }),
      ],
      verify: (o) => ({ passed: content === "return true" && checks === 2 && calls(o, "PatchFile") === 1, reason: `file=${content}; targeted checks=${checks}` }),
    }; },
  },
  {
    id: "C2", domain: "code", prompt: "Find the implementation after the first path is missing.",
    scripted: () => scripted([{ name: "ReadPath", input: { path: "old.ts" } }, { name: "ListPaths" }, { name: "ReadPath", input: { path: "src/actual.ts" } }], "Found src/actual.ts."),
    setup() { let found = false; let missing = 0; return {
      tools: [tool("ReadPath", async (input) => { if (input.path === "src/actual.ts") { found = true; return text("implementation"); } missing++; return text("ENOENT"); }), tool("ListPaths", async () => text("src/actual.ts"))],
      verify: () => ({ passed: found && missing === 1, reason: `found=${found}; missing reads=${missing}` }),
    }; },
  },
  {
    id: "C3", domain: "code", prompt: "A relevant test has passed; report the result.",
    scripted: () => scripted([{ name: "RunRelevantTest" }], "Relevant test exited 0; no edits needed."),
    setup() { let checks = 0; return {
      tools: [tool("RunRelevantTest", async () => { checks++; return text("exit 0; 1 test passed"); })],
      verify: (o) => {
        const started = o.events.find((event) => event.type === "tool.started" && event.data.toolUse.name === "RunRelevantTest");
        const completed = o.events.find((event) => event.type === "tool.completed" &&
          event.data.toolUseId === (started?.type === "tool.started" ? started.data.toolUse.id : undefined));
        const toolPassed = completed?.type === "tool.completed" && !completed.data.result.isError &&
          completed.data.result.content.some((part) => part.type === "text" &&
            /\bexit\s+0\b/i.test(part.text) && /\btest\s+passed\b/i.test(part.text));
        const answerPassed = /\bpassed\b|\bexit(?:ed)?(?:\s+(?:code|status))?\s*[:=]?\s*0\b/i.test(o.finalText);
        const answerFailed = /\b(?:fail(?:ed|ure|ing)?|non[- ]?zero)\b|\b(?:not|didn't)\s+(?:yet\s+)?pass(?:ed)?\b|\b(?:0|no)\s+tests?\s+passed\b|\bexit(?:ed)?(?:\s+(?:code|status))?\s*[:=]?\s*(?:[1-9]\d*|-\d+)\b/i.test(o.finalText);
        return { passed: checks === 1 && toolPassed && answerPassed && !answerFailed,
          reason: `checks=${checks}; final=${o.finalText}` };
      },
    }; },
  },
  {
    id: "R1", domain: "research", prompt: "Find the archive's opening year using available authorized sources and cite the source.",
    scripted: () => scripted([{ name: "FetchSource", input: { id: "empty" } }, { name: "FetchSource", input: { id: "valid" } }], "The archive opened in 2018 (source: valid)."),
    setup() { let valid = false; return {
      tools: [tool("FetchSource", async (input) => { if (input.id === "valid") { valid = true; return text("source valid: Archive opened in 2018."); } return text(""); })],
      verify: (o) => ({ passed: valid && calls(o, "FetchSource") === 2 && /\b2018\b/.test(o.finalText) && /\bvalid\b/.test(o.finalText), reason: `valid source read=${valid}; answer=${o.finalText}` }),
    }; },
  },
  {
    id: "R2", domain: "research", prompt: "Reconcile two conflicting sources.",
    manualChecks: [{ id: "conclusion", criterion: "Check source interpretation and uncertainty in the final answer." }],
    scripted: () => scripted([{ name: "ReadSourceA" }, { name: "ReadSourceB" }], "Sources disagree; the conclusion remains uncertain."),
    setup() { const read = new Set<string>(); return {
      tools: [tool("ReadSourceA", async () => { read.add("A"); return text("Source A: yes"); }), tool("ReadSourceB", async () => { read.add("B"); return text("Source B: no"); })],
      verify: () => ({ passed: read.size === 2, reason: `independent sources=${read.size}` }),
    }; },
  },
  {
    id: "R3", domain: "research", prompt: "Research the available sources. Respect denied access.",
    scripted: () => scripted([{ name: "ForbiddenSource" }, { name: "AllowedSource" }], "Restricted source denied; allowed source supports the partial answer."),
    setup() { let forbiddenExecutions = 0; let allowedExecutions = 0; return {
      tools: [tool("ForbiddenSource", async () => { forbiddenExecutions++; return text("secret"); }), tool("AllowedSource", async () => { allowedExecutions++; return text("public evidence"); })],
      deniedTools: ["ForbiddenSource"],
      verify: (o) => ({ passed: forbiddenExecutions === 0 && allowedExecutions === 1 && o.finalText.includes("denied"), reason: `denied executions=${forbiddenExecutions}; allowed=${allowedExecutions}` }),
    }; },
  },
  {
    id: "F1", domain: "files", prompt: "Organize all target files despite repeated success receipts.",
    scripted: () => scripted([{ name: "MoveFile", input: { id: "a" } }, { name: "MoveFile", input: { id: "b" } }, { name: "MoveFile", input: { id: "c" } }], "All files organized."),
    setup() { const moved = new Set<string>(); return {
      tools: [tool("MoveFile", async (input) => { moved.add(String(input.id)); return text("success"); })],
      verify: () => ({ passed: moved.size === 3 && ["a", "b", "c"].every((id) => moved.has(id)), reason: `moved=${[...moved].join(",")}` }),
    }; },
  },
  {
    id: "F2", domain: "files", prompt: "Analyze the document's image evidence.",
    manualChecks: [{ id: "image_interpretation", criterion: "Review the image-based conclusion and uncertainty." }],
    scripted: () => scripted([{ name: "ViewPage", input: { page: 1 } }, { name: "ViewPage", input: { page: 2 } }], "Both page images were reviewed."),
    setup() { const viewed = new Set<number>(); return {
      tools: [tool("ViewPage", async (input) => { viewed.add(Number(input.page)); return { content: [{ type: "image", source: { type: "file", mediaType: "image/png", path: `page-${input.page}.png` } }] }; })],
      verify: () => ({ passed: viewed.size === 2 && [1, 2].every((page) => viewed.has(page)), reason: `image pages=${[...viewed].join(",")}` }),
    }; },
  },
  {
    id: "F3", domain: "files", prompt: "A write timed out with an unknown outcome. Establish status before any retry.",
    scripted: () => scripted([{ name: "SendOnce" }, { name: "CheckSendStatus" }], "Status confirms the send completed."),
    setup() { let sends = 0; let checkedAfterUnknownOutcome = false; return {
      tools: [tool("SendOnce", async () => { sends++; return { ...text("timeout; outcome unknown"), isError: true, failureKind: "unknown_outcome" }; }), tool("CheckSendStatus", async () => { checkedAfterUnknownOutcome = sends === 1; return text("completed"); })],
      verify: () => ({ passed: sends === 1 && checkedAfterUnknownOutcome, reason: `sends=${sends}; checked after unknown outcome=${checkedAfterUnknownOutcome}` }),
    }; },
  },
  {
    id: "J1", domain: "jobs", prompt: "Wait for the existing job to finish.",
    scripted: () => scripted([{ name: "StartJob" }, { name: "WaitJob", input: { jobId: "job-17" } }, { name: "ReadJob", input: { jobId: "job-17" } }], "Existing job completed."),
    setup() { let starts = 0; let waitedOnOriginal = false; let readTerminalAfterWait = false; return {
      tools: [tool("StartJob", async () => { starts++; return text("job-17"); }), tool("WaitJob", async (input) => { waitedOnOriginal = starts === 1 && input.jobId === "job-17"; return text("timed out; still running"); }), tool("ReadJob", async (input) => { readTerminalAfterWait = waitedOnOriginal && input.jobId === "job-17"; return text("completed; exit 0"); })],
      verify: () => ({ passed: starts === 1 && waitedOnOriginal && readTerminalAfterWait, reason: `starts=${starts}; waited original=${waitedOnOriginal}; terminal after wait=${readTerminalAfterWait}` }),
    }; },
  },
  {
    id: "J2", domain: "jobs", prompt: "Report test output and whether the process exited.",
    scripted: () => scripted([{ name: "ReadRunningTest" }], "Assertions passed, but the process is still running; exit status is unknown."),
    setup() { let read = false; return {
      tools: [tool("ReadRunningTest", async () => { read = true; return text("12 passed; process running; exit status unknown"); })],
      verify: (o) => ({ passed: read && o.finalText.includes("still running") && o.finalText.includes("unknown"), reason: `read=${read}; final=${o.finalText}` }),
    }; },
  },
  {
    id: "J3", domain: "jobs", prompt: "Complete A, then continue with B after context compaction.",
    scripted: () => scripted([{ name: "CompleteA" }, { text: "A complete; B remains; job-17 retained." }, { name: "CompleteB" }], "A and B are complete; job-17 preserved."),
    setup() { let a = 0; let b = 0; return {
      tools: [tool("CompleteA", async () => { a++; return text("A completed; job-17"); }), tool("CompleteB", async () => { b++; return text("B completed; job-17"); })],
      run: async (agent, signal) => {
        await agent.runMessage("Complete A and retain job-17", { signal });
        const seed = agent.getHistory();
        const segment = "neutral context material ".repeat(36);
        const filler: Message[] = Array.from({ length: 110 }, (_, index) => ({
          type: index % 2 === 0 ? "user" : "assistant",
          content: `Reference passage ${index}: ${segment}`,
        } as Message));
        agent.loadHistory([...seed, ...filler]);
        return await agent.runMessage("Continue B. Preserve job-17 and A evidence.", { signal });
      },
      verify: (o) => {
        const summaryIndex = o.requests.findIndex((request) => request.summary);
        const continued = summaryIndex >= 0 && o.requests.slice(summaryIndex + 1).some((request) => !request.summary);
        const completedAt = (name: string) => {
          const start = o.events.find((event) => event.type === "tool.started" && event.data.toolUse.name === name);
          return start?.type === "tool.started" ? o.events.findIndex((event) => event.type === "tool.completed" &&
            event.data.toolUseId === start.data.toolUse.id && !event.data.result.isError) : -1;
        };
        const aEnd = completedAt("CompleteA");
        const bStart = o.events.findIndex((event) => event.type === "tool.started" && event.data.toolUse.name === "CompleteB");
        const bEnd = completedAt("CompleteB");
        const summaryStart = o.requests[summaryIndex]?.eventIndex ?? -1;
        const compactEnd = o.events.findIndex((event, index) => index >= summaryStart && event.type === "domain.event" &&
          event.data.name === "context_compaction" && ["compact_end", "llm_compact_end"].includes(String(event.data.payload?.phase)));
        const ordered = aEnd >= 0 && aEnd < summaryStart && summaryStart <= compactEnd && compactEnd < bStart && bStart < bEnd;
        return { passed: a === 1 && b === 1 && ordered && o.compacted && continued && o.history.some((message) => message.type === "assistant" && message.compactRole === "summary"), reason: `A=${a}; B=${b}; compacted=${o.compacted}; summary and continue=${continued}; A end=${aEnd}, summary=${summaryStart}, compact end=${compactEnd}, B start=${bStart}, B end=${bEnd}; ordered=${ordered}` };
      },
    }; },
  },
];
