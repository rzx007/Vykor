import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  estimatedToolTokens: number; questions: number; permissionsBypassed: number;
  prematureStop?: boolean; redundantVerification?: boolean;
}

export interface BehaviorRunOptions {
  client: StreamingMessageClient;
  model: string; revision: string; repeat: number;
  maxRequests: number; timeoutMs: number;
  sharedBudget?: { remainingRequests: number };
  signal?: AbortSignal;
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
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let estimatedToolTokens = 0;
  let questions = 0;
  const requestsSeen: Array<{ summary: boolean; toolNames: string[] }> = [];
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
      requestsSeen.push({ summary: params.maxTokens === 20_000 && !params.tools, toolNames });
      estimatedToolTokens += Math.ceil(JSON.stringify(params.tools ?? []).length / 4);
      for await (const event of options.client.streamMessage({ ...params, abortSignal: controller.signal })) {
        if (event.type === "usage") {
          inputTokens = (inputTokens ?? 0) + event.usage.inputTokens;
          outputTokens = (outputTokens ?? 0) + event.usage.outputTokens;
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
      onEvent: (event) => { events.push(event); },
      resolveModelContextWindow: async () => 50_000,
    });
    runResult = fixture.run
      ? await fixture.run(agent, controller.signal)
      : await agent.runMessage(scenario.prompt, { signal: controller.signal });
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
  return {
    caseId: scenario.id, revision: options.revision, model: options.model, repeat: options.repeat,
    status, reason,
    requestCount: requests,
    toolCalls: events.filter((event) => event.type === "tool.started").length,
    elapsedMs: Date.now() - started,
    ...(inputTokens === undefined ? {} : { actualInputTokens: inputTokens }),
    ...(outputTokens === undefined ? {} : { actualOutputTokens: outputTokens }),
    estimatedToolTokens, questions, permissionsBypassed,
  };
}
