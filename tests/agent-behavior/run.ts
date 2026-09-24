import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentEvent, AgentRunResult, Settings, StreamingMessageClient, StreamMessageParams } from "@vykor/core";
import { createDefaultNodeAgent, type VykorAgent } from "@vykor/agent-runtime";
import { buildWorkStyleSection, getDefaultIdentity, getInvariantGuidance } from "@vykor/prompts";
import type { BehaviorCase } from "./cases.js";

export interface BehaviorResult {
  caseId: string; revision: string; model: string; repeat: number;
  status: "passed" | "failed" | "timed_out" | "cancelled" | "budget_cancelled" | "pending_review" | "not_run";
  reason: string; toolCalls: number; elapsedMs: number;
  requestCount: number;
  actualInputTokens?: number; actualOutputTokens?: number;
  usageCoverage?: { knownInputTokens: number; knownOutputTokens: number; missingInputRequests: number; missingOutputRequests: number };
  estimatedToolTokens: number; questions: number; permissionsBypassed: number;
  toolCatalogRequests?: ToolCatalogRequest[];
  toolSelectionErrors?: number;
  prematureStop?: boolean; redundantVerification?: boolean;
  evidence?: {
    finalText?: string;
    outputText: string;
    events: ReviewEvent[];
    requests: readonly { summary: boolean; toolNames: string[]; eventIndex: number }[];
  };
}

type ReviewEvent = { eventIndex: number } & (
  | { type: "tool.started"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool.completed"; id: string; content: Extract<AgentEvent, { type: "tool.completed" }>["data"]["result"]["content"]; isError?: boolean }
  | { type: "output.text.delta"; text: string }
  | { type: "context_compaction"; phase: string }
);

// Every invocation reserves its own file, even when the caller repeats an explicit basename.
export function reserveBehaviorReport(requested = join(tmpdir(), "vykor-agent-baseline.json")) {
  const target = resolve(requested);
  const rel = relative(resolve(tmpdir()), target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("VYKOR_EVAL_OUT must be under the system temporary directory");
  const extension = extname(target);
  const runId = randomUUID();
  const path = `${target.slice(0, target.length - extension.length)}-${runId}${extension || ".json"}`;
  writeFileSync(path, "{}", { flag: "wx" });
  return { path, runId, save: (report: unknown) => writeFileSync(path, JSON.stringify(report, null, 2)) };
}

export interface ToolCatalogRequest {
  definitionCount: number;
  serializedLength: number;
  estimatedToolTokens: number;
  estimateMethod: "heuristic_v1";
  actualInputTokens?: number;
  actualOutputTokens?: number;
  /** Estimated definition tokens divided by reported input tokens; not an exact token or cost attribution. */
  estimatedToolTokenShareOfActualInput?: number;
}

export interface BehaviorRunOptions {
  client: StreamingMessageClient;
  model: string; revision: string; repeat: number;
  maxRequests: number; timeoutMs: number;
  sharedBudget?: { remainingRequests: number };
  signal?: AbortSignal;
  relevantToolNames?: readonly string[];
}

export const behaviorSystemPrompt = [
  getDefaultIdentity(), getInvariantGuidance(), buildWorkStyleSection("practical"),
  "Only use the supplied scenario tools. Respect permissions and report uncertainty.",
].join("\n\n");

export async function runBehaviorCase(scenario: BehaviorCase, options: BehaviorRunOptions): Promise<BehaviorResult> {
  if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1 || options.timeoutMs < 1) {
    throw new Error("A positive request budget and deadline are required");
  }
  if (options.sharedBudget && options.sharedBudget.remainingRequests < 1) {
    return { caseId: scenario.id, revision: options.revision, model: options.model, repeat: options.repeat,
      status: "not_run", reason: "shared request budget exhausted before sample", toolCalls: 0, requestCount: 0,
      elapsedMs: 0, estimatedToolTokens: 0, questions: 0, permissionsBypassed: 0 };
  }
  const started = Date.now();
  const fixture = scenario.setup();
  const cwd = mkdtempSync(join(tmpdir(), "vykor-behavior-"));
  const previousConfig = process.env.VYKOR_CONFIG_DIR;
  process.env.VYKOR_CONFIG_DIR = join(cwd, "config");
  const events: AgentEvent[] = [];
  let permissionsBypassed = 0;
  const denied = new Set(fixture.deniedTools ?? []);
  const wrap = (tool: typeof fixture.tools[number]) => ({ ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
    if (denied.has(tool.name)) permissionsBypassed++;
    return await tool.execute(...args);
  } });
  const customTools = fixture.tools.map(wrap);
  const overrides = fixture.toolOverrides?.map(wrap);
  const tools = [...customTools, ...(overrides ?? [])];
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(options.signal?.reason ?? new Error("sample cancelled"));
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) onExternalAbort();
  let requests = 0;
  let budgetExceeded = false;
  let timedOut = false;
  let estimatedToolTokens = 0;
  const toolCatalogRequests: ToolCatalogRequest[] = [];
  let questions = 0;
  const requestsSeen: Array<{ summary: boolean; toolNames: string[]; eventIndex: number }> = [];
  const evidence: NonNullable<BehaviorResult["evidence"]> = { outputText: "", events: [], requests: requestsSeen };
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("sample deadline reached"));
  }, options.timeoutMs);
  const client: StreamingMessageClient = {
    prepareUserContent: options.client.prepareUserContent?.bind(options.client),
    async *streamMessage(params: StreamMessageParams) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (requests >= options.maxRequests || (options.sharedBudget && options.sharedBudget.remainingRequests < 1)) {
        budgetExceeded = true;
        controller.abort(new Error("request budget exhausted"));
        throw controller.signal.reason;
      }
      requests++;
      if (options.sharedBudget) options.sharedBudget.remainingRequests--;
      const toolNames = params.tools?.map((tool) => tool.name) ?? [];
      requestsSeen.push({ summary: params.maxTokens === 20_000 && !params.tools, toolNames, eventIndex: events.length });
      const serializedLength = params.tools?.length ? JSON.stringify(params.tools).length : 0;
      const requestCatalog: ToolCatalogRequest = {
        definitionCount: params.tools?.length ?? 0,
        serializedLength,
        estimatedToolTokens: Math.ceil(serializedLength / 4),
        estimateMethod: "heuristic_v1",
      };
      toolCatalogRequests.push(requestCatalog);
      estimatedToolTokens += requestCatalog.estimatedToolTokens;
      for await (const event of options.client.streamMessage({ ...params, abortSignal: controller.signal })) {
        if (event.type === "usage") {
          requestCatalog.actualInputTokens = (requestCatalog.actualInputTokens ?? 0) + event.usage.inputTokens;
          requestCatalog.actualOutputTokens = (requestCatalog.actualOutputTokens ?? 0) + event.usage.outputTokens;
          if (requestCatalog.actualInputTokens > 0) {
            requestCatalog.estimatedToolTokenShareOfActualInput = requestCatalog.estimatedToolTokens / requestCatalog.actualInputTokens;
          }
        }
        yield event;
      }
    },
  };
  const settings: Settings = {
    model: options.model, apiFormat: "openai", maxTurns: 20,
    permission: { mode: "full_auto", allowedTools: tools.map((tool) => tool.name), deniedTools: fixture.deniedTools },
    hooks: [], memory: { enabled: false, sessionMemoryEnabled: false, autoExtractEnabled: false },
    sandbox: { enabled: false }, mcpServers: {}, plugins: { enabled: false },
    workStyle: "practical", effort: "", fastMode: false,
  };
  let agent: VykorAgent | undefined;
  let runResult: AgentRunResult | undefined;
  let reason = "";
  let status: BehaviorResult["status"] = "failed";
  try {
    agent = await createDefaultNodeAgent({
      cwd, sessionId: `behavior-${scenario.id}-${options.repeat}`,
      client, settings, mcpServers: {}, extensions: [], pluginsEnabled: false,
      model: options.model, maxTurns: 20, hostToolCeiling: tools.map((tool) => tool.name),
      systemPrompt: behaviorSystemPrompt,
      tools: customTools, toolOverrides: overrides,
      effects: { askUserPrompt: async () => { questions++; return "No answer supplied in scripted evaluation"; } },
      capabilityOverrides: {
        jobs: false, terminal: false, backgroundShell: false, childEnvironment: false,
        workflowRepository: false, schedules: false, memory: false,
      },
      onEvent: (event) => {
        const eventIndex = events.length;
        events.push(event);
        // Isolated scripted fixtures only: retain reviewable public evidence, not reasoning,
        // event contexts, provider configuration or arbitrary metadata. Live scrubbing is not implemented.
        if (event.type === "tool.started") {
          const { id, name, input } = event.data.toolUse;
          evidence.events.push({ eventIndex, type: event.type, id, name, input: structuredClone(input) });
        } else if (event.type === "tool.completed") {
          evidence.events.push({ eventIndex, type: event.type, id: event.data.toolUseId,
            content: structuredClone(event.data.result.content.filter((part) => part.type === "text" || part.type === "image")),
            isError: event.data.result.isError });
        } else if (event.type === "output.text.delta") {
          evidence.outputText += event.data.delta;
          evidence.events.push({ eventIndex, type: event.type, text: event.data.delta });
        } else if (event.type === "domain.event" && event.data.name === "context_compaction") {
          evidence.events.push({ eventIndex, type: "context_compaction", phase: String(event.data.payload?.phase) });
        }
      },
      resolveModelContextWindow: async () => 50_000,
    });
    runResult = fixture.run
      ? await fixture.run(agent, controller.signal)
      : await agent.runMessage(scenario.prompt, { signal: controller.signal });
    evidence.finalText = runResult.output;
    const history = agent.getHistory();
    const verdict = fixture.verify({
      history, events, runResult, finalText: runResult.output, requests: requestsSeen,
      compacted: events.some((event) => event.type === "domain.event" && event.data.name === "context_compaction" &&
        ["compact_end", "llm_compact_end"].includes(String(event.data.payload?.phase))),
    });
    reason = verdict.reason;
    status = verdict.passed ? scenario.manualChecks?.length ? "pending_review" : "passed" : "failed";
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
    status = timedOut ? "timed_out" : budgetExceeded ? "budget_cancelled" : options.signal?.aborted ? "cancelled" : "failed";
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
    if (agent) {
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          agent.close(),
          new Promise<never>((_, reject) => { closeTimer = setTimeout(() => reject(new Error("agent close exceeded 5 seconds")), 5_000); }),
        ]);
      } catch (error) {
        reason = `${reason}; cleanup: ${error instanceof Error ? error.message : String(error)}`;
        if (status === "passed" || status === "pending_review") status = "failed";
      } finally {
        if (closeTimer) clearTimeout(closeTimer);
      }
    }
    if (previousConfig === undefined) delete process.env.VYKOR_CONFIG_DIR;
    else process.env.VYKOR_CONFIG_DIR = previousConfig;
    rmSync(cwd, { recursive: true, force: true });
  }
  const usageCoverage = {
    knownInputTokens: toolCatalogRequests.reduce((sum, request) => sum + (request.actualInputTokens ?? 0), 0),
    knownOutputTokens: toolCatalogRequests.reduce((sum, request) => sum + (request.actualOutputTokens ?? 0), 0),
    missingInputRequests: toolCatalogRequests.filter((request) => request.actualInputTokens === undefined).length,
    missingOutputRequests: toolCatalogRequests.filter((request) => request.actualOutputTokens === undefined).length,
  };
  return {
    caseId: scenario.id, revision: options.revision, model: options.model, repeat: options.repeat,
    status, reason,
    requestCount: requests,
    toolCalls: events.filter((event) => event.type === "tool.started").length,
    elapsedMs: Date.now() - started,
    ...(requests > 0 && usageCoverage.missingInputRequests === 0 ? { actualInputTokens: usageCoverage.knownInputTokens } : {}),
    ...(requests > 0 && usageCoverage.missingOutputRequests === 0 ? { actualOutputTokens: usageCoverage.knownOutputTokens } : {}),
    usageCoverage, evidence,
    estimatedToolTokens, toolCatalogRequests,
    ...(options.relevantToolNames === undefined ? {} : {
      toolSelectionErrors: events.filter((event) => event.type === "tool.started" &&
        !options.relevantToolNames!.includes(event.data.toolUse.name)).length,
    }),
    questions, permissionsBypassed,
  };
}
