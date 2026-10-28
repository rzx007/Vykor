import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDefaultNodeAgent, type DefaultNodeAgent } from "@vykor/agent-runtime";
import type { AgentChildBudget, AgentChildHandle, AgentEvent, AgentEventListener, AgentExecutionContext, Message, StreamingMessageClient, ToolDefinition, ToolResult } from "@vykor/agent-contracts";
import type { JobTarget, JobInputReceipt, JobReadResult, JobWaitResult, JobSnapshot, JobListResult } from "@vykor/jobs";
import { decodeJobTarget, decodeJobInputReceipt, decodeJobReadResult, decodeJobWaitResult, decodeJobSnapshot, decodeJobListResult } from "@vykor/protocol";
import { SessionStore } from "@vykor/services";
import { DaemonApplication } from "@vykor/server";
import { markTrustedReadOnlyTool } from "@vykor/core";
import { recoverProjectionSettlements } from "../../../../packages/server/src/application/agent/projection-settlement-recovery.js";

type AgentTarget = Extract<JobTarget, { kind: "agent" }>;
export interface LifecycleFixture {
  agent: DefaultNodeAgent;
  store?: SessionStore;
  terminals?: DaemonApplication["terminals"];
  /** Offline network script; tools, child admission and returned handles stay real. */
  scriptChild(prompt: string, steps: Array<{ name: string; input: Record<string, unknown> | ((results: ToolResult[]) => Record<string, unknown>) }>): ToolResult[];
  spawn(prompt: string): Promise<{ handle: AgentChildHandle; target: AgentTarget }>;
  /** Direct admission through the real root's captured child controller. Expected rejection does not dispatch a mutating Agent tool. */
  admit(prompt: string, timeoutSeconds?: number): Promise<{ handle: AgentChildHandle; target: AgentTarget }>;
  admitMany(prompts: string[]): Promise<PromiseSettledResult<{ handle: AgentChildHandle; target: AgentTarget }>[]>;
  sendMany(inputs: Array<{ target: AgentTarget; text: string }>): Promise<PromiseSettledResult<JobInputReceipt>[]>;
  sendAccepted(target: AgentTarget, text: string): Promise<JobInputReceipt>;
  modelCalls(label: string): number;
  holdModel(label: string): void;
  modelEntered(label: string): Promise<void>;
  releaseModel(label: string): void;
  observedHistory(label: string): string[];
  observedCwd(label: string): string | undefined;
  environmentAcquires(): number;
  setCatalogModels(models: string[]): void;
  holdApproval(): void;
  approvalEntered(): Promise<void>;
  releaseApproval(): void;
  inRootRun(probe: (execution: AgentExecutionContext) => Promise<void>): Promise<void>;
  holdCleanup(label: string): void;
  cleanupEntered(label: string): Promise<void>;
  releaseCleanup(label: string): void;
  read(target: JobTarget): Promise<JobReadResult>;
  wait(target: JobTarget, timeoutMs?: number): Promise<JobWaitResult>;
  send(target: AgentTarget, text: string): Promise<JobInputReceipt>;
  cancel(target: JobTarget): Promise<JobSnapshot>;
  list(): Promise<JobListResult>;
  hold(label: string): void;
  entered(label: string): Promise<void>;
  release(label: string): void;
  restoreTerminalSave(): Promise<void>;
  redeliverTerminal(runId: string): Promise<void>;
  close(): Promise<void>;
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const invocations = new WeakMap<LifecycleFixture, (name: string, input: Record<string, unknown>) => Promise<Record<string, any>>>();
/** Extra domain tools still execute through the real root model/tool pipeline. */
export function invokeLifecycleTool(fixture: LifecycleFixture, name: string, input: Record<string, unknown>) {
  return invocations.get(fixture)!(name, input);
}
function text(message: Message | undefined): string {
  if (!message || message.type === "tool_result") return "";
  return typeof message.content === "string" ? message.content : message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("");
}
function payload(result: ToolResult): Record<string, any> {
  const body = result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("");
  if (result.isError) throw new Error(body);
  return JSON.parse(body);
}

export async function createLifecycleFixture(mode: "sdk" | "daemon", options: { childBudget?: Partial<AgentChildBudget>; blockOnUnknownToolOutcome?: boolean; failTerminalSave?: boolean; failStartedAck?: boolean | number; failChildCreated?: boolean; failLeaseReleaseOnce?: boolean; failShellSave?: boolean; catalogModels?: string[]; failCleanupOnce?: string; failure?: { label: string; kind: "failed" | "max_turns"; once?: boolean } } = {}): Promise<LifecycleFixture> {
  const directory = mkdtempSync(join(tmpdir(), `shared-jobs-${mode}-`));
  if (options.failure?.kind === "max_turns") writeFileSync(join(directory, `${options.failure.label}.txt`), "finalization input");
  let environmentAcquires = 0;
  let approval: { entered: ReturnType<typeof gate>; released: ReturnType<typeof gate> } | undefined;
  const customProvider = { id: "fixture-provider", displayName: "Fixture", apiFormat: "openai" as const, baseUrl: "https://fixture.invalid/v1", models: (options.catalogModels ?? []).map(id => ({ id, displayName: id })) };
  const holds = new Map<string, { entered: ReturnType<typeof gate>; released: ReturnType<typeof gate> }>();
  const modelHolds = new Map<string, { entered: ReturnType<typeof gate>; released: ReturnType<typeof gate> }>();
  const cleanups = new Map<string, { entered: ReturnType<typeof gate>; released: ReturnType<typeof gate> }>();
  const labelsByRun = new Map<string, string>();
  const calls = new Map<string, number>();
  const histories = new Map<string, string[]>();
  const cwds = new Map<string, string>();
  const scripts = new Map<string, { name: string; input: Record<string, unknown>; result?: ToolResult; probe?: (execution: AgentExecutionContext) => Promise<void>; probeError?: unknown }>();
  const childScripts = new Map<string, { steps: Array<{ name: string; input: Record<string, unknown> | ((results: ToolResult[]) => Record<string, unknown>) }>; results: ToolResult[] }>();
  const names = ["Agent", "JobRead", "JobWait", "JobSend", "JobCancel", "JobList", "BackgroundShellCreate", "TerminalOpen", "Workflow"];
  const decorators = names.map(name => ({ name, decorate: (base: ToolDefinition): ToolDefinition => ({ ...base, execute: async (input, context) => {
    const script = context.toolCallId ? scripts.get(context.toolCallId) : undefined;
    if (script?.probe) {
      try { await script.probe(context.agent!); } catch (error) { script.probeError = error; }
    }
    const result = await base.execute(input, context);
    if (script) script.result = result;
    return result;
  } }) }));
  // This host-controlled fault wrapper adds only waiting to the original Read.
  // Decorators intentionally lose first-party identity, so explicitly attest its
  // known read-only behavior while exercising the unchanged S1 ledger.
  decorators.push({ name: "Read", decorate: (base: ToolDefinition): ToolDefinition => markTrustedReadOnlyTool({ ...base, execute: async (input, context) => {
    const label = String(input.file_path ?? "").split(/[\\/]/).at(-1)?.replace(/\.txt$/, "");
    const hold = label ? holds.get(label) : undefined;
    if (label && context.agent) { labelsByRun.set(context.agent.scope.runId, label); cwds.set(label, context.agent.scope.cwd); }
    const result = await base.execute(input, context);
    if (hold) { hold.entered.resolve(); await hold.released.promise; }
    return result;
  } }) });
  const client: StreamingMessageClient = { async *streamMessage(params) {
    const last = params.messages.at(-1);
    const prompt = text(last);
    const script = prompt.startsWith("fixture-call:") ? scripts.get(prompt.slice("fixture-call:".length)) : undefined;
    if (script) {
      yield { type: "tool_use_start", toolUse: { type: "tool_use", id: prompt.slice("fixture-call:".length), name: script.name, input: script.input } };
      yield { type: "complete", stopReason: "tool_use" };
      return;
    }
    const latestUser = [...params.messages].reverse().find(message => message.type === "user");
    const label = text(latestUser).split("\n")[0]!.trim();
    const childScript = childScripts.get(label);
    if (childScript) {
      if (last?.type === "tool_result") childScript.results.push({ content: last.content, ...(last.isError ? { isError: true } : {}) });
      const step = childScript.steps[childScript.results.length];
      if (step) {
        const input = typeof step.input === "function" ? step.input(childScript.results) : step.input;
        yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `child-script-${randomUUID()}`, name: step.name, input } };
        yield { type: "complete", stopReason: "tool_use" };
      } else {
        yield { type: "text_delta", delta: `completed:${label}` };
        yield { type: "complete", stopReason: "end_turn" };
      }
      return;
    }
    histories.set(label, params.messages.map(message => text(message)));
    if (!label.startsWith("fixture-call:")) calls.set(label, (calls.get(label) ?? 0) + 1);
    const modelHold = modelHolds.get(label);
    if (modelHold && last?.type !== "tool_result") { modelHold.entered.resolve(); await modelHold.released.promise; }
    if (label === "parent-retained" && last?.type !== "tool_result") {
      yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "real-descendant", name: "Agent", input: { prompt: "descendant-held", description: "retained descendant", subagentType: "worker", allowedTools: ["Read"] } } };
      yield { type: "complete", stopReason: "tool_use" }; return;
    }
    if (label === "approval-held" && last?.type !== "tool_result") {
      yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "real-approval", name: "Write", input: { file_path: join(directory, "approved.txt"), content: "approved" } } };
      yield { type: "complete", stopReason: "tool_use" }; return;
    }
    if (options.failure?.label === label && (!options.failure.once || calls.get(label) === 1)) {
      if (options.failure.kind === "max_turns") {
        if (calls.get(label) === 1) {
          yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "limit-read", name: "Read", input: { file_path: join(directory, `${label}.txt`) } } };
          yield { type: "complete", stopReason: "tool_use" };
        } else {
          yield { type: "text_delta", delta: "final:" + "x".repeat(12_001) };
          yield { type: "complete", stopReason: "end_turn" };
        }
        return;
      }
      throw new Error(`failure:${label}`);
    }
    if (holds.has(label) && last?.type !== "tool_result") {
      if (label.startsWith("partial-")) yield { type: "text_delta", delta: `committed:${label}` };
      yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `read-${randomUUID()}`, name: "Read", input: { file_path: join(directory, `${label}.txt`) } } };
      yield { type: "complete", stopReason: "tool_use" };
    } else {
      yield { type: "text_delta", delta: label.startsWith("fixture-call:") ? "fixture completed" : label || "completed" };
      yield { type: "complete", stopReason: "end_turn" };
    }
  } };
  const settings = { model: "offline", apiFormat: "openai" as const, maxTurns: 8, permission: { mode: "full_access" as const }, plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false }, ...(options.blockOnUnknownToolOutcome === undefined ? {} : { blockOnUnknownToolOutcome: options.blockOnUnknownToolOutcome }), ...(options.childBudget ? { childBudget: options.childBudget } : {}), ...(options.catalogModels ? { provider: customProvider.id, customProviders: [customProvider] } : {}) };
  let node!: DefaultNodeAgent;
  let application: DaemonApplication | undefined;
  let store: SessionStore | undefined;
  let rootSessionId = `fixture-${randomUUID()}`;
  let restoreSave = () => {};
  let reliableSink: AgentEventListener | undefined;
  const terminalEvents = new Map<string, AgentEvent>();
  let sdkStarts = 0;
  const observeEvent: AgentEventListener = async event => {
    if (["run.completed", "run.failed", "run.interrupted"].includes(event.type) && event.context.runId) terminalEvents.set(event.context.runId, event);
    if (mode === "sdk" && options.failStartedAck && event.type === "run.started" && event.context.childId && ++sdkStarts === (typeof options.failStartedAck === "number" ? options.failStartedAck : 1)) throw new Error("injected started projection failure");
  };
  let leaseFailureInjected = false;
  let cleanupFailureInjected = false;
  const releaseRun = async (runId: string, release?: () => void | Promise<void>) => {
    const label = labelsByRun.get(runId) ?? "";
    const cleanup = cleanups.get(label);
    if (cleanup) { cleanup.entered.resolve(); await cleanup.released.promise; }
    if (options.failCleanupOnce === label && !cleanupFailureInjected) { cleanupFailureInjected = true; throw new Error("injected run cleanup failure"); }
    await release?.();
  };
  const childEnvironment = { acquire: async (input: { prompt: string; cwd: string }) => { environmentAcquires++; return ({ cwd: input.cwd, release: async () => {
    if (options.failLeaseReleaseOnce && !leaseFailureInjected) { leaseFailureInjected = true; throw new Error("injected environment release failure"); }
    const cleanup = cleanups.get(input.prompt);
    if (cleanup) { cleanup.entered.resolve(); await cleanup.released.promise; }
  } }); } };
  const requestPermission: import("@vykor/agent-contracts").AgentEffects["requestPermission"] = async (input) => {
    if (approval && input.toolName === "Write") { approval.entered.resolve(); await approval.released.promise; }
    return { status: "approved", decision: "once" };
  };
  if (mode === "daemon") {
    store = new SessionStore({ path: join(directory, "sessions.db") });
    if (options.failChildCreated) {
      const create = store.sessions.create.bind(store.sessions);
      let failed = false;
      store.sessions.create = input => {
        if (input.parentId && !failed) { failed = true; throw new Error("injected child.created projection failure"); }
        return create(input);
      };
    }
    if (options.failTerminalSave) {
      const update = store.runs.updateRun.bind(store.runs);
      store.runs.updateRun = (id, input) => {
        const run = store!.runs.getRun(id);
        if (run && store!.sessions.get(run.sessionId)?.parentId && ["completed", "failed", "interrupted"].includes(input.status ?? "")) throw new Error("injected terminal save failure");
        return update(id, input);
      };
      restoreSave = () => { store!.runs.updateRun = update; };
    }
    if (options.failStartedAck || options.failShellSave) {
      const update = store.runs.updateSessionTask.bind(store.runs);
      let starts = 0;
      store.runs.updateSessionTask = (id, input) => {
        if (options.failStartedAck && input.status === "running" && store!.runs.getSessionTask(id)?.childSessionId && ++starts === (typeof options.failStartedAck === "number" ? options.failStartedAck : 1)) {
          throw new Error("injected started projection failure");
        }
        if (options.failShellSave && ["completed", "failed", "stopped"].includes(input.status ?? "") && store!.runs.getSessionTask(id)?.type === "shell") throw new Error("injected shell terminal save failure");
        return update(id, input);
      };
      const previousRestore = restoreSave;
      restoreSave = () => { previousRestore(); store!.runs.updateSessionTask = update; };
    }
    application = new DaemonApplication({ store, settings, log: () => {}, createAgent: async ({ options }) => {
      options.toolDecorators = [...(options.toolDecorators ?? []), ...decorators];
      options.capabilityOverrides = { ...options.capabilityOverrides, childEnvironment };
      options.effects = { ...options.effects, requestPermission };
      if (options.sessionId === rootSessionId) {
        reliableSink = options.onEvent;
        options.onEvent = async event => { await observeEvent(event); await reliableSink?.(event); };
      }
      const original = options.onRunCapabilities;
      options.onRunCapabilities = async snapshot => {
        const release = await original?.(snapshot);
        return async () => {
          await releaseRun(snapshot.scope.runId, release);
        };
      };
      const node = await createDefaultNodeAgent({ ...options, client });
      if (options.sessionId === rootSessionId) { /* the loader creates the root lazily */ }
      rootNode(node, options.sessionId);
      return { agent: node, host: node.host };
    } });
    await application.ready();
    rootSessionId = application.commands.createSession({ cwd: directory, model: "offline" }).id;
  } else node = await createDefaultNodeAgent({ cwd: directory, sessionId: rootSessionId, settings, client, onEvent: observeEvent, effects: { requestPermission }, toolDecorators: decorators, childBudget: options.childBudget, capabilityOverrides: { childEnvironment },
    onRunCapabilities: snapshot => async () => {
      await releaseRun(snapshot.scope.runId);
    },
  });

  function rootNode(created: DefaultNodeAgent, sessionId?: string) { if (sessionId === rootSessionId) node = created; }
  const invoke = async (name: string, input: Record<string, unknown>, probe?: (execution: AgentExecutionContext) => Promise<void>) => {
    const id = `fixture-${randomUUID()}`;
    const script = { name, input, result: undefined as ToolResult | undefined, probe, probeError: undefined as unknown };
    scripts.set(id, script);
    try {
      if (application) {
        const admitted = await application.interactions.admitPrompt(rootSessionId, { items: [{ type: "text", text: `fixture-call:${id}` }] });
        const run = await application.runControl.awaitRun(rootSessionId, admitted.run!.id);
        if (run.status !== "completed") throw new Error(`Root run ${run.status}: ${run.error ?? ""}; ${JSON.stringify(script.result)}`);
      } else await node.runMessage(`fixture-call:${id}`);
      if (!script.result) throw new Error(`Real ${name} tool did not execute: ${JSON.stringify(node.getHistory().slice(-4))}; operations=${JSON.stringify(store?.toolOperations.listSafetyStates().filter(row => row.state === "unknown"))}`);
      if (script.probeError) throw script.probeError;
      return payload(script.result);
    } finally { scripts.delete(id); }
  };
  await invoke("JobList", {});
  const admit = async (execution: AgentExecutionContext, prompt: string, timeoutSeconds?: number) => {
    const receipt = await execution.children.spawnChildAgent({ prompt, description: prompt, agent: "worker", cwd: directory, allowedTools: ["Read"], ...(timeoutSeconds ? { timeoutSeconds } : {}) });
    const handle = node.children.get(receipt.id)!;
    return { handle, target: { kind: "agent" as const, jobId: handle.id, runId: receipt.runId } };
  };
  const fixture: LifecycleFixture = {
    agent: node, ...(store ? { store } : {}), ...(application ? { terminals: application.terminals } : {}),
    scriptChild: (prompt, steps) => { const results: ToolResult[] = []; childScripts.set(prompt, { steps, results }); return results; },
    admit: async (prompt, timeoutSeconds) => {
      let result!: Awaited<ReturnType<typeof admit>>;
      await invoke("JobList", {}, async execution => { result = await admit(execution, prompt, timeoutSeconds); });
      return result;
    },
    admitMany: async prompts => {
      let result!: PromiseSettledResult<Awaited<ReturnType<typeof admit>>>[];
      await invoke("JobList", {}, async execution => { result = await Promise.allSettled(prompts.map(prompt => admit(execution, prompt))); });
      return result;
    },
    sendAccepted: async (target, content) => {
      let receipt!: JobInputReceipt;
      await invoke("JobList", {}, async execution => { receipt = await node.children.get(target.jobId)!.send({ content }, execution.tools); });
      return receipt;
    },
    sendMany: async inputs => {
      let result!: PromiseSettledResult<JobInputReceipt>[];
      await invoke("JobList", {}, async execution => { result = await Promise.allSettled(inputs.map(({ target, text }) => node.children.get(target.jobId)!.send({ content: text }, execution.tools))); });
      return result;
    },
    modelCalls: label => calls.get(label) ?? 0,
    holdModel: label => modelHolds.set(label, { entered: gate(), released: gate() }),
    modelEntered: label => modelHolds.get(label)!.entered.promise,
    releaseModel: label => modelHolds.get(label)!.released.resolve(),
    observedHistory: label => histories.get(label) ?? [],
    observedCwd: label => cwds.get(label),
    environmentAcquires: () => environmentAcquires,
    setCatalogModels: models => { customProvider.models = models.map(id => ({ id, displayName: id })); },
    holdApproval: () => { approval = { entered: gate(), released: gate() }; },
    approvalEntered: () => approval!.entered.promise,
    releaseApproval: () => approval?.released.resolve(),
    inRootRun: async probe => { await invoke("JobList", {}, probe); },
    holdCleanup: label => cleanups.set(label, { entered: gate(), released: gate() }),
    cleanupEntered: label => cleanups.get(label)!.entered.promise,
    releaseCleanup: label => cleanups.get(label)!.released.resolve(),
    spawn: async prompt => {
      const result = await invoke("Agent", { prompt, description: prompt, subagentType: "worker", allowedTools: ["Read"], ...(options.failure?.label === prompt && options.failure.kind === "max_turns" ? { maxTurns: 2 } : {}) });
      const target = decodeJobTarget(result.target);
      if (target.kind !== "agent") throw new Error("Agent receipt must select a run");
      const handle = node.children.get(target.jobId);
      if (!handle || handle.sessionId !== result.childSessionId || handle.readRun(target.runId).receipt.inputId !== result.inputId) throw new Error("Child receipt did not select the real handle");
      return { handle, target };
    },
    read: async target => decodeJobReadResult(await invoke("JobRead", { target })),
    wait: async (target, timeoutMs = 5_000) => {
      const result = await invoke("JobWait", { targets: [{ target }], timeoutSeconds: timeoutMs / 1_000 });
      const waited = result.results[0];
      if (waited.error) throw new Error(waited.error);
      return decodeJobWaitResult(waited);
    },
    send: async (target, data) => decodeJobInputReceipt((await invoke("JobSend", { target, data })).receipt),
    cancel: async target => decodeJobSnapshot((await invoke("JobCancel", { target })).snapshot),
    list: async () => decodeJobListResult(await invoke("JobList", {})),
    hold: label => { holds.set(label, { entered: gate(), released: gate() }); writeFileSync(join(directory, `${label}.txt`), label); },
    entered: label => holds.get(label)!.entered.promise,
    release: label => holds.get(label)!.released.resolve(),
    restoreTerminalSave: async () => {
      restoreSave();
      if (store && recoverProjectionSettlements(store).pending) throw new Error(`Terminal recovery failed: ${JSON.stringify(store.listProjectionSettlements({ status: ["pending", "retrying"] }))}`);
    },
    redeliverTerminal: async runId => {
      const saved = store?.listProjectionSettlements().find(record => (record.payload.event as AgentEvent | undefined)?.context.runId === runId);
      const event = saved?.payload.event as AgentEvent | undefined ?? terminalEvents.get(runId);
      if (!event || !reliableSink) throw new Error("Original durable terminal event is unavailable");
      await reliableSink(event);
    },
    close: async () => {
      restoreSave();
      approval?.released.resolve();
      for (const hold of modelHolds.values()) hold.released.resolve();
      for (const hold of holds.values()) hold.released.resolve();
      for (const cleanup of cleanups.values()) cleanup.released.resolve();
      await Promise.allSettled(node.children.list().map(handle => handle.result));
      if (application) await application.close(); else await node.close();
      store?.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
  invocations.set(fixture, invoke);
  return fixture;
}
