import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AgentExecutionContext, ApprovalMode, ToolDefinition } from "@vykor/agent-contracts";
import { createExecutionEnvironment } from "@vykor/sandbox";
import { createVykorRuntime } from "../default-runtime.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(initial: ApprovalMode, hold: "approval" | "invocation") {
  let selected = initial;
  const entered = deferred(), released = deferred();
  const policies: boolean[] = [], approvals: string[] = [];
  const cwd = process.cwd();
  const settings = { model: "test", apiFormat: "anthropic" as const, permission: { mode: "ask" as const },
    sandbox: { enabled: true, network: { mode: "none" as const } } };
  const environment = await createExecutionEnvironment({
    config: { mode: "local", kind: "local", failClosed: false, cwd, sandbox: {} as never },
    settings, binding: { kind: "local", hostRoot: cwd, executionRoot: cwd }, sessionId: "s", userSkillsRoot: cwd,
  }, { createShellProcess: async (_command, options) => {
    policies.push(options.settings!.sandbox!.enabled!);
    const child = new EventEmitter() as never;
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    setImmediate(() => { (child as EventEmitter).emit("exit", 0); (child as EventEmitter).emit("close", 0); });
    return child;
  } });
  const probe: ToolDefinition = { name: "PolicyProbe", description: "Observe process policy", inputSchema: { type: "object" },
    execute: async (input, context) => {
      if (input.old && hold === "invocation") { entered.resolve(); await released.promise; }
      await context.environment!.process.execShell("echo probe");
      return { content: [{ type: "text", text: `${runtime.getApprovalMode?.() ?? "missing"}:${runtime.settings.sandbox!.enabled}` }] };
    } };
  const runtime = await createVykorRuntime({ settings, cwd, sessionId: "s", executionEnvironment: environment,
    configuration: { approvalMode: initial, readApprovalMode: () => selected, tools: [probe],
      client: { async *streamMessage() { yield { type: "complete" as const, stopReason: "end_turn" as const }; } },
    },
  });
  const registered = runtime.toolRegistry.get("PolicyProbe")!;
  const execution: AgentExecutionContext = {
    scope: { agentId: "s", sessionId: "s", runId: "r", inputId: "i", traceId: "t", cwd, signal: new AbortController().signal },
    tools: new Map([[registered.name, { definition: registered, invoke: registered.execute, source: { kind: "agent" } }]]),
    effects: { requestPermission: async request => {
      approvals.push(runtime.getApprovalMode?.() ?? "missing");
      if (request.input?.old && hold === "approval") { entered.resolve(); await released.promise; }
      return { status: "approved", decision: "once" };
    } },
    children: {} as never, emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {}, observeInvocation() {},
  };
  let count = 0;
  return { runtime, entered, released, policies, approvals, select: (mode: ApprovalMode) => { selected = mode; },
    execute: (old = false) => runtime.queryEngine.executeTool({ type: "tool_use", id: `probe-${++count}`, name: "PolicyProbe", input: { old } }, { execution }),
  };
}

describe("live runtime approval policy", () => {
  it("narrows independent command hooks and newly created integration processes", async () => {
    const f = await fixture("full_access", "invocation");
    try {
      f.runtime.hookExecutor.register({ id: "start", event: "session_start", type: "command", command: "echo hook", enabled: true });
      await f.runtime.hookExecutor.execute("session_start", {});
      f.select("ask");
      await f.runtime.hookExecutor.execute("session_start", {});
      await f.runtime.processExecutor!.execShell("echo integration");
      expect(f.policies).toEqual([false, true, true]);
    } finally { await f.runtime.close(); }
  });

  it("uses all three modes for new calls while keeping an old approval's environment", async () => {
    const f = await fixture("ask", "approval");
    const old = f.execute(true);
    try {
      await f.entered.promise;
      f.select("full_access");
      expect(await f.execute()).toMatchObject({ content: [{ type: "text", text: "full_access:false" }] });
      f.select("auto_review");
      expect(await f.execute()).toMatchObject({ content: [{ type: "text", text: "auto_review:true" }] });
      f.released.resolve();
      expect(await old).toMatchObject({ content: [{ type: "text", text: "ask:true" }] });
      f.select("ask");
      expect(await f.execute()).toMatchObject({ content: [{ type: "text", text: "ask:true" }] });
      expect(f.approvals).toEqual(["ask", "auto_review", "ask"]);
      expect(f.policies).toEqual([false, true, true, true]);
    } finally { f.released.resolve(); await old; await f.runtime.close(); }
  });

  it("keeps an already running full-access invocation when new calls are narrowed", async () => {
    const f = await fixture("full_access", "invocation");
    const old = f.execute(true);
    try {
      await f.entered.promise;
      f.select("ask");
      expect(await f.execute()).toMatchObject({ content: [{ type: "text", text: "ask:true" }] });
      f.released.resolve();
      expect(await old).toMatchObject({ content: [{ type: "text", text: "full_access:false" }] });
      expect(f.approvals).toEqual(["ask"]);
      expect(f.policies).toEqual([true, false]);
    } finally { f.released.resolve(); await old; await f.runtime.close(); }
  });
});
