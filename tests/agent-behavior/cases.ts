import type { AgentEvent, AgentRunResult, Message, StreamingMessageClient, ToolDefinition } from "@vykor/core";
import type { VykorAgent } from "@vykor/agent-runtime";
import { fileURLToPath } from "node:url";
import { validateToolInput } from "../../packages/core/src/engine/tool-input-schema.js";

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

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], execute: ToolDefinition["execute"]): ToolDefinition {
  const inputSchema = { type: "object", properties, required, additionalProperties: false };
  return { name, description, inputSchema, execute: async (input, context) => {
    const error = validateToolInput(inputSchema, input);
    return error ? { ...text(`Invalid input: ${error}`), isError: true, failureKind: "invalid_input" } : execute(input, context);
  } };
}
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const calls = (observation: BehaviorObservation, name: string) =>
  observation.events.filter((event) => event.type === "tool.started" && event.data.toolUse.name === name).length;

export const behaviorCases: BehaviorCase[] = [
  {
    id: "C1", domain: "code", prompt: "The targeted flag test fails: expected true, received false. In src/flag.ts the current implementation is `return false`. Fix that line and rerun the targeted test.",
    scripted: () => scripted([{ name: "RunTargetTest" }, { name: "ReadFile", input: { path: "src/flag.ts" } },
      { name: "PatchFile", input: { path: "src/flag.ts", oldText: "return false", newText: "return true" } }, { name: "RunTargetTest" }], "Targeted test passes; fix complete."),
    setup() { let content = "return false"; let checks = 0; let passedAfterPatch = false; return {
      tools: [
        tool("RunTargetTest", "Run the focused flag test and return its exit code, assertion diagnostics, and relevant source line.", {}, [], async () => {
          checks++; if (content === "return true") passedAfterPatch = true;
          return text(content === "return true" ? "exit 0; 1 test passed" : `exit 1; flag test: expected true, received false; src/flag.ts:1: ${content}`);
        }),
        tool("ReadFile", "Read the current contents of a known source file before editing it.", { path: { type: "string", enum: ["src/flag.ts"] } }, ["path"], async () => text(`src/flag.ts:1: ${content}`)),
        tool("PatchFile", "Replace one exact source line in src/flag.ts; the old text must match the current file.", {
          path: { type: "string", enum: ["src/flag.ts"] }, oldText: { type: "string", minLength: 1 }, newText: { type: "string", minLength: 1 },
        }, ["path", "oldText", "newText"], async (input) => {
          if (input.oldText !== content || input.newText !== "return true") return { ...text("Patch did not match the current line or requested fix"), isError: true };
          content = "return true"; return text("saved src/flag.ts");
        }),
      ],
      verify: (o) => ({ passed: content === "return true" && checks >= 1 && passedAfterPatch && calls(o, "PatchFile") >= 1 && /pass/i.test(o.finalText), reason: `file=${content}; targeted checks=${checks}; passed after patch=${passedAfterPatch}` }),
    }; },
  },
  {
    id: "C2", domain: "code", prompt: "Find the flag implementation. The old reference points to src/old.ts; if it is missing, list the source files and inspect the real implementation.",
    scripted: () => scripted([{ name: "ReadPath", input: { path: "src/old.ts" } }, { name: "ListPaths", input: { directory: "src" } }, { name: "ReadPath", input: { path: "src/actual.ts" } }], "Found src/actual.ts."),
    setup() { let found = false; let missing = 0; let missingInitial = false; return {
      tools: [
        tool("ReadPath", "Read a repository file by its path; return ENOENT when that path does not exist.", { path: { type: "string", minLength: 1 } }, ["path"], async (input) => {
          if (input.path === "src/actual.ts") { found = true; return text("src/actual.ts: flag implementation returns true"); }
          missing++; if (input.path === "src/old.ts") missingInitial = true;
          return { ...text(`ENOENT: ${input.path}`), isError: true };
        }),
        tool("ListPaths", "List existing source file paths, optionally within a directory.", { directory: { type: "string", enum: ["src"] } }, [], async () => text("src/actual.ts")),
      ],
      verify: () => ({ passed: found && missingInitial, reason: `found=${found}; initial path missing=${missingInitial}; missing reads=${missing}` }),
    }; },
  },
  {
    id: "C3", domain: "code", prompt: "The focused test just completed: exit 0, 1 test passed. No files or code have changed since. Report the result without running the test again.",
    scripted: () => scripted([], "Focused test: **passed** — exit 0, 1/1 tests passing. No changes since the run; did not re-run."),
    setup() { let checks = 0; return {
      tools: [tool("RunRelevantTest", "Run the focused test again and return its exit code and assertion count.", {}, [], async () => { checks++; return text("exit 0; 1 test passed"); })],
      verify: (o) => {
        const answer = o.finalText.replace(/\*{1,2}/g, "");
        const answerPassed = /\b(?:focused|relevant|the|that|this)\s+test\s+(?:has\s+)?passed\b|\bit\s+(?:has\s+)?passed\b/i.test(answer) ||
          /\b(?:focused|relevant|the|that|this)\s+test(?:\s+result)?\s*:\s*pass(?:ed)?\b/i.test(answer) ||
          /(?:^|[;.!?]\s*|\n\s*)test\s*:\s*pass(?:ed)?\b/i.test(answer) ||
          /(?:^|[;.!?]\s*|,\s*|\n\s*)1\/1\s+tests?\s+pass(?:ed|ing)\b/i.test(answer) ||
          /(?:^|[;.!?]\s*|\n\s*)tests?\s*:\s*1\s+passed\b/i.test(answer);
        const withoutZeroFailures = answer.replace(/(^|[,;.!?:]\s*|\n\s*)(?:0|zero|no)\s+(?:(?:tests?|cases?)\s+)?(?:failed|failures?)\b/gi, "$1");
        const answerFailed = /\b(?:fail(?:ed|ure|ing)?|non[- ]?zero)\b|\b(?:not|didn't)\s+(?:yet\s+)?pass(?:ed)?\b|\b(?:0|no)\s+tests?\s+passed\b|\bexit(?:ed)?(?:\s+(?:code|status))?\s*[:=]?\s*(?:[1-9]\d*|-\d+)\b/i.test(withoutZeroFailures);
        const answerUncertain = /\b(?:do(?:es)?|did)\s+not\s+know\b|\b(?:don['’]t|doesn['’]t|didn['’]t)\s+know\b|\b(?:cannot|can't|couldn't|unable to)\s+(?:confirm|verify|tell|determine)\b|\b(?:not\s+sure|unsure|uncertain|unclear\s+(?:whether|if))\b/i.test(answer);
        const wrongExitCode = [...answer.matchAll(/\b(?:exit(?:ed)?|return(?:ed)?|status)(?:\s+(?:with\s+)?(?:code|status))?\s*(?:(?:is|was|of)\s*|[:=]\s*)?(-?\d+)\b/gi)]
          .some((match) => Number(match[1]) !== 0);
        const withoutValidFraction = answer.replace(/\b1\/1\s+tests?\s+pass(?:ed|ing)\b/gi, "");
        const wrongTestCount = /\btests\b(?:\s+[a-z]+){0,2}\s+pass(?:ed|ing)\b/i.test(withoutValidFraction) ||
          [...withoutValidFraction.matchAll(/\b(\d+)\s+test\s+passed\b/gi)].some((match) => Number(match[1]) !== 1) ||
          [...answer.matchAll(/\b(\d+)\/(\d+)\s+tests?\s+pass(?:ed|ing)\b/gi)]
            .some((match) => Number(match[1]) !== 1 || Number(match[2]) !== 1);
        const withoutNoChange = answer.replace(/\bno\s+(?:files?|code)(?:\s+or\s+(?:files?|code))?\s+(?:(?:was|were|has|have)\s+)?(?:been\s+)?(?:changed|modified|edited|updated)\b/gi, "");
        const claimsChange = /\b(?:i|we)\s+(?:(?:have|had)\s+)?(?:changed|modified|edited|updated)\s+(?:(?:the|any|some|a|one|two)\s+)?(?:code|files?|source)\b|\b(?:i|we)\s+made\s+changes?\s+to\s+(?:the\s+)?(?:code|files?)\b|\b(?:files?|code|source)\s+(?:(?:was|were|has|have)\s+)?(?:been\s+)?(?:changed|modified|edited|updated)\b/i.test(withoutNoChange);
        const requiredRelevantSubject = !/\b(?:unrelated|another|other|different)\s+tests?\b/i.test(answer) &&
          (/\b(?:focused|relevant|the|that|this)\s+test\b|\bit\s+(?:has\s+)?passed\b/i.test(answer) ||
            /(?:^|[;.!?]\s*|\n\s*)tests?\s*:/i.test(answer) ||
            /(?:^|[;.!?]\s*|,\s*|\n\s*)1\/1\s+tests?\s+pass(?:ed|ing)\b/i.test(answer));
        return { passed: checks === 0 && !o.events.some((event) => event.type === "tool.started") &&
          requiredRelevantSubject && answerPassed && !answerFailed && !answerUncertain && !wrongExitCode && !wrongTestCount && !claimsChange,
          reason: `checks=${checks}; final=${o.finalText}` };
      },
    }; },
  },
  {
    id: "R1", domain: "research", prompt: "Find the opening year of the fictional Aster Archive. Available authorized records have IDs `empty` (a catalog index) and `valid` (the archive's opening notice). Cite the record that supports the year.",
    scripted: () => scripted([{ name: "FetchSource", input: { id: "empty" } }, { name: "FetchSource", input: { id: "valid" } }], "Aster Archive opened in 2018 (source: valid)."),
    setup() { let valid = false; return {
      tools: [tool("FetchSource", "Fetch one authorized Aster Archive record by ID. The catalog index may lack the year; the opening notice is primary evidence.", {
        id: { type: "string", enum: ["empty", "valid"] },
      }, ["id"], async (input) => { if (input.id === "valid") { valid = true; return text("source valid (opening notice): Aster Archive opened in 2018."); } return text("source empty (catalog index): Aster Archive entry; opening year unavailable here."); })],
      verify: (o) => ({ passed: valid && /\b2018\b/.test(o.finalText) && /\bvalid\b/.test(o.finalText), reason: `valid source read=${valid}; answer=${o.finalText}` }),
    }; },
  },
  {
    id: "R2", domain: "research", prompt: "Two authorized records disagree on whether the fictional Aster Archive has public evening access. Read both and report what can and cannot be concluded.",
    manualChecks: [{ id: "conclusion", criterion: "Check source interpretation and uncertainty in the final answer." }],
    scripted: () => scripted([{ name: "ReadSourceA" }, { name: "ReadSourceB" }], "Sources disagree; the conclusion remains uncertain."),
    setup() { const read = new Set<string>(); return {
      tools: [tool("ReadSourceA", "Read the Aster Archive visitor guide's statement about evening access.", {}, [], async () => { read.add("A"); return text("Visitor guide: evening access is available."); }),
        tool("ReadSourceB", "Read the Aster Archive service bulletin's statement about evening access.", {}, [], async () => { read.add("B"); return text("Service bulletin: evening access is unavailable."); })],
      verify: (o) => ({ passed: read.size === 2 && /(?:disagree|conflict|uncertain|cannot conclude|can't conclude|inconclusive)/i.test(o.finalText),
        reason: `independent sources=${read.size}; answer=${o.finalText}` }),
    }; },
  },
  {
    id: "R3", domain: "research", prompt: "Research the Aster Archive's public access policy. ForbiddenSource is denied and must not be used. AllowedSource is available; give a bounded answer from that public evidence.",
    scripted: () => scripted([{ name: "AllowedSource" }], "Allowed public source supports a partial answer; the restricted source is unavailable.",),
    setup() { let forbiddenExecutions = 0; let allowedExecutions = 0; return {
      tools: [tool("ForbiddenSource", "Restricted Aster Archive staff record; access is denied for this task.", {}, [], async () => { forbiddenExecutions++; return text("secret"); }),
        tool("AllowedSource", "Read the public Aster Archive access notice about visitor access.", {}, [], async () => { allowedExecutions++; return text("Public notice: daytime visitor access is available; evening access is not addressed."); })],
      deniedTools: ["ForbiddenSource"],
      verify: (o) => ({ passed: forbiddenExecutions === 0 && allowedExecutions >= 1 &&
        /(?:public|allowed|daytime)/i.test(o.finalText) && /(?:partial|limited|unknown|unavailable|cannot|can't|not addressed|restricted|denied)/i.test(o.finalText),
        reason: `denied executions=${forbiddenExecutions}; allowed=${allowedExecutions}; answer=${o.finalText}` }),
    }; },
  },
  {
    id: "F1", domain: "files", prompt: "Move exactly the target files with IDs a, b, and c into destination `archive`. Each move returns the same generic success receipt; track which IDs were actually moved.",
    scripted: () => scripted([{ name: "MoveFile", input: { id: "a", destination: "archive" } }, { name: "MoveFile", input: { id: "b", destination: "archive" } }, { name: "MoveFile", input: { id: "c", destination: "archive" } }], "All files organized."),
    setup() { const moved = new Set<string>(); return {
      tools: [tool("MoveFile", "Move one known target file ID into the archive destination. Repeating a move is idempotent.", {
        id: { type: "string", enum: ["a", "b", "c"] }, destination: { type: "string", enum: ["archive"] },
      }, ["id", "destination"], async (input) => { moved.add(String(input.id)); return text("success"); })],
      verify: () => ({ passed: moved.size === 3 && ["a", "b", "c"].every((id) => moved.has(id)), reason: `moved=${[...moved].join(",")}` }),
    }; },
  },
  {
    id: "F2", domain: "files", prompt: "Compare the light and dark image previews of the Vykor architecture. View both pages (1 is light, 2 is dark) and describe one visible structural similarity and one visual difference. State any detail you cannot verify from the images.",
    manualChecks: [{ id: "image_interpretation", criterion: "Review the image-based conclusion and uncertainty." }],
    scripted: () => scripted([{ name: "ViewPage", input: { page: 1 } }, { name: "ViewPage", input: { page: 2 } }], "Both page images were reviewed."),
    setup() { const viewed = new Set<number>(); const pages = {
      1: fileURLToPath(new URL("../../docs/vykor-current-architecture.visual-check.1440x900.light.png", import.meta.url)),
      2: fileURLToPath(new URL("../../docs/vykor-current-architecture.visual-check.1440x900.dark.png", import.meta.url)),
    }; return {
      tools: [tool("ViewPage", "View one checked-in architecture preview image: page 1 is light and page 2 is dark.", {
        page: { type: "integer", enum: [1, 2] },
      }, ["page"], async (input) => { const page = input.page as 1 | 2; viewed.add(page); return { content: [{ type: "image", source: { type: "file", mediaType: "image/png", path: pages[page] } }] }; })],
      verify: () => ({ passed: viewed.size === 2 && [1, 2].every((page) => viewed.has(page)), reason: `image pages=${[...viewed].join(",")}` }),
    }; },
  },
  {
    id: "F3", domain: "files", prompt: "The earlier send `send-17` timed out; its outcome is unknown. Check that send's status before considering a retry. Avoid creating a duplicate send if it already completed.",
    scripted: () => scripted([{ name: "CheckSendStatus", input: { sendId: "send-17" } }], "send-17 completed; no retry needed."),
    setup() { let sends = 0; let checked = false; return {
      tools: [tool("SendOnce", "Retry a send by ID. This may create a duplicate if the original timed-out send succeeded.", {
        sendId: { type: "string", enum: ["send-17"] },
      }, ["sendId"], async () => { sends++; return { ...text("duplicate send created"), isError: true, failureKind: "unknown_outcome" }; }),
      tool("CheckSendStatus", "Check the server-side outcome of the previously timed-out send ID without sending again.", {
        sendId: { type: "string", enum: ["send-17"] },
      }, ["sendId"], async () => { checked = true; return text("send-17 completed; original send succeeded"); })],
      verify: (o) => ({ passed: sends === 0 && checked && /(?:completed|succeeded|sent)/i.test(o.finalText), reason: `duplicate sends=${sends}; original checked=${checked}; answer=${o.finalText}` }),
    }; },
  },
  {
    id: "J1", domain: "jobs", prompt: "An existing job `job-17` is already running. Wait for that job; if the wait times out while it is still running, read the same job's terminal status. Do not start another job.",
    scripted: () => scripted([{ name: "WaitJob", input: { jobId: "job-17" } }, { name: "ReadJob", input: { jobId: "job-17" } }], "Existing job-17 completed with exit 0."),
    setup() { let starts = 0; let waitedOnOriginal = false; let readTerminalAfterWait = false; return {
      tools: [tool("StartJob", "Start a new job; the requested job-17 already exists, so this would create unrelated work.", {}, [], async () => { starts++; return text("job-18 started"); }),
        tool("WaitJob", "Wait for the existing job-17; a timeout means it is still running, not that it failed.", {
          jobId: { type: "string", enum: ["job-17"] },
        }, ["jobId"], async () => { waitedOnOriginal = true; return text("wait timed out; job-17 still running"); }),
        tool("ReadJob", "Read the terminal status of job-17 after waiting; return its actual exit code.", {
          jobId: { type: "string", enum: ["job-17"] },
        }, ["jobId"], async () => { if (!waitedOnOriginal) return { ...text("job-17 still running; exit status unknown"), isError: true }; readTerminalAfterWait = true; return text("job-17 completed; exit 0"); })],
      verify: (o) => ({ passed: starts === 0 && waitedOnOriginal && readTerminalAfterWait && /(?:completed|finished|exit 0)/i.test(o.finalText), reason: `new starts=${starts}; waited original=${waitedOnOriginal}; terminal after wait=${readTerminalAfterWait}` }),
    }; },
  },
  {
    id: "J2", domain: "jobs", prompt: "Report test output and whether the process exited.",
    scripted: () => scripted([{ name: "ReadRunningTest" }], "Assertions passed, but the process is still running; exit status is unknown."),
    setup() { let read = false; return {
      tools: [tool("ReadRunningTest", "Read the latest output and process state of the still-running test job; exit status may be unknown.", {}, [], async () => { read = true; return text("12 passed; process running; exit status unknown"); })],
      verify: (o) => ({
        passed: read && /still running/i.test(o.finalText) &&
          /\b(?:unknown|unavailable|not available|no exit (?:status|code))\b/i.test(o.finalText) &&
          !/\b(?:exit(?:ed)?|return(?:ed)?|status)(?:\s+(?:with\s+)?(?:code|status))?\s*[:=]?\s*\d+\b/i.test(o.finalText),
        reason: `read=${read}; final=${o.finalText}`,
      }),
    }; },
  },
  {
    id: "J3", domain: "jobs", prompt: "Complete A, then continue with B after context compaction.",
    scripted: () => scripted([{ name: "CompleteA" }, { text: "A complete; B remains; job-17 retained." }, { name: "CompleteB" }], "A and B are complete; job-17 preserved."),
    setup() { let a = 0; let b = 0; return {
      tools: [tool("CompleteA", "Complete step A and return the retained job-17 identifier for the handoff.", {}, [], async () => { a++; return text("A completed; job-17"); }),
        tool("CompleteB", "Complete step B using the preserved A evidence and job-17 identifier.", {}, [], async () => { b++; return text("B completed; job-17"); })],
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
