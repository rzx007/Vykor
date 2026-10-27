import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDefaultNodeAgent, type DefaultNodeAgent } from "@vykor/agent-runtime";
import type { AgentChildBudget, AgentChildHandle, Message, StreamingMessageClient, ToolDefinition, ToolResult } from "@vykor/agent-contracts";
import type { JobTarget, JobInputReceipt, JobReadResult, JobWaitResult, JobSnapshot, JobListResult } from "@vykor/jobs";
import { decodeJobTarget, decodeJobInputReceipt, decodeJobReadResult, decodeJobWaitResult, decodeJobSnapshot, decodeJobListResult } from "@vykor/protocol";
import { SessionStore } from "@vykor/services";
import { DaemonApplication } from "@vykor/server";

type AgentTarget = Extract<JobTarget, { kind: "agent" }>;
export interface LifecycleFixture {
  agent: DefaultNodeAgent;
  store?: SessionStore;
  spawn(prompt: string): Promise<{ handle: AgentChildHandle; target: AgentTarget }>;
  read(target: JobTarget): Promise<JobReadResult>;
  wait(target: JobTarget, timeoutMs?: number): Promise<JobWaitResult>;
  send(target: AgentTarget, text: string): Promise<JobInputReceipt>;
  cancel(target: JobTarget): Promise<JobSnapshot>;
  list(): Promise<JobListResult>;
  hold(label: string): void;
  entered(label: string): Promise<void>;
  release(label: string): void;
  restoreTerminalSave(): Promise<void>;
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

export async function createLifecycleFixture(mode: "sdk" | "daemon", options: { childBudget?: Partial<AgentChildBudget>; failTerminalSave?: boolean } = {}): Promise<LifecycleFixture> {
  const directory = mkdtempSync(join(tmpdir(), `shared-jobs-${mode}-`));
  const holds = new Map<string, { entered: ReturnType<typeof gate>; released: ReturnType<typeof gate> }>();
  const scripts = new Map<string, { name: string; input: Record<string, unknown>; result?: ToolResult }>();
  const names = ["Agent", "JobRead", "JobWait", "JobSend", "JobCancel", "JobList", "BackgroundShellCreate", "TerminalOpen", "Workflow"];
  const decorators = names.map(name => ({ name, decorate: (base: ToolDefinition): ToolDefinition => ({ ...base, execute: async (input, context) => {
    const result = await base.execute(input, context);
    const script = context.toolCallId ? scripts.get(context.toolCallId) : undefined;
    if (script) script.result = result;
    return result;
  } }) }));
  decorators.push({ name: "Read", decorate: (base: ToolDefinition): ToolDefinition => ({ ...base, execute: async (input, context) => {
    const label = String(input.file_path ?? "").split(/[\\/]/).at(-1)?.replace(/\.txt$/, "");
    const hold = label ? holds.get(label) : undefined;
    if (hold) { hold.entered.resolve(); await hold.released.promise; }
    return await base.execute(input, context);
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
    if (holds.has(label) && last?.type !== "tool_result") {
      yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `read-${randomUUID()}`, name: "Read", input: { file_path: join(directory, `${label}.txt`) } } };
      yield { type: "complete", stopReason: "tool_use" };
    } else {
      yield { type: "text_delta", delta: label.startsWith("fixture-call:") ? "fixture completed" : label || "completed" };
      yield { type: "complete", stopReason: "end_turn" };
    }
  } };
  const settings = { model: "offline", apiFormat: "openai" as const, maxTurns: 8, permission: { mode: "full_access" as const }, plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false }, ...(options.childBudget ? { childBudget: options.childBudget } : {}) };
  let node!: DefaultNodeAgent;
  let application: DaemonApplication | undefined;
  let store: SessionStore | undefined;
  let rootSessionId = `fixture-${randomUUID()}`;
  let restoreSave = () => {};
  if (mode === "daemon") {
    store = new SessionStore({ path: join(directory, "sessions.db") });
    if (options.failTerminalSave) {
      const update = store.runs.updateRun.bind(store.runs);
      store.runs.updateRun = (id, input) => {
        const run = store!.runs.getRun(id);
        if (run && store!.sessions.get(run.sessionId)?.parentId && ["completed", "failed", "interrupted"].includes(input.status ?? "")) throw new Error("injected terminal save failure");
        return update(id, input);
      };
      restoreSave = () => { store!.runs.updateRun = update; };
    }
    application = new DaemonApplication({ store, settings, log: () => {}, createAgent: async ({ options }) => {
      options.toolDecorators = [...(options.toolDecorators ?? []), ...decorators];
      const node = await createDefaultNodeAgent({ ...options, client });
      if (options.sessionId === rootSessionId) { /* the loader creates the root lazily */ }
      rootNode(node, options.sessionId);
      return { agent: node, host: node.host };
    } });
    await application.ready();
    rootSessionId = application.commands.createSession({ cwd: directory, model: "offline" }).id;
  } else node = await createDefaultNodeAgent({ cwd: directory, sessionId: rootSessionId, settings, client, toolDecorators: decorators, childBudget: options.childBudget });

  function rootNode(created: DefaultNodeAgent, sessionId?: string) { if (sessionId === rootSessionId) node = created; }
  const invoke = async (name: string, input: Record<string, unknown>) => {
    const id = `fixture-${randomUUID()}`;
    const script = { name, input, result: undefined as ToolResult | undefined };
    scripts.set(id, script);
    try {
      if (application) {
        const admitted = await application.interactions.admitPrompt(rootSessionId, { items: [{ type: "text", text: `fixture-call:${id}` }] });
        const run = await application.runControl.awaitRun(rootSessionId, admitted.run!.id);
        if (run.status !== "completed") throw new Error(`Root run ${run.status}: ${run.error ?? ""}; ${JSON.stringify(script.result)}`);
      } else await node.runMessage(`fixture-call:${id}`);
      if (!script.result) throw new Error(`Real ${name} tool did not execute`);
      return payload(script.result);
    } finally { scripts.delete(id); }
  };
  if (!node) await invoke("JobList", {});
  const fixture: LifecycleFixture = {
    agent: node, ...(store ? { store } : {}),
    spawn: async prompt => {
      const result = await invoke("Agent", { prompt, description: prompt, subagentType: "worker", allowedTools: ["Read"] });
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
    restoreTerminalSave: async () => restoreSave(),
    close: async () => {
      restoreSave();
      for (const hold of holds.values()) hold.released.resolve();
      await Promise.allSettled(node.children.list().map(handle => handle.result));
      if (application) await application.close(); else await node.close();
      store?.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
  invocations.set(fixture, invoke);
  return fixture;
}
