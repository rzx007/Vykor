import type { AgentEvent, AgentChildController, StreamingMessageClient } from "@vykor/agent-contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


import type { Settings } from "@vykor/host-config";
import { describe, expect, it, vi } from "vitest";

import type { AgentRunCapabilitySnapshot, VykorAgentConfiguration } from "../../agent/agent-options.js";
import { unavailableCapability, type ResolvedAgentCapabilities } from "../../capabilities/capability-resolution.js";
import { createInProcessChildEnvironmentProvider } from "../../children/child-environment.js";
import { createDefaultNodeAgent } from "../../agent/default-agent.js";
import {  createFixtureNodeAgent as createAgentKernel, createFixtureRuntime as createBasicAgentKernelRuntime  } from "../../agent/__test__/host-assembly.test-support.js";
type AgentKernelRuntimeContext=any;
import { createRunCapabilityView } from "../run-capability-view.js";

const settings: Settings = {
  model: "lifecycle-script", apiFormat: "anthropic", maxTurns: 8,
  permission: { mode: "default" }, sandbox: { enabled: false }, memory: { enabled: false },
};
const candidates = ["P", "Q"].map(pluginId => ({
  pluginId, displayName: pluginId, description: pluginId, version: "1", behaviorDigest: `${pluginId}-digest`,
}));

describe("host Run capability lifecycle", () => {
  it("registers the prepared exact scope after durable start and before either receipt or model dispatch", async () => {
    const entered = deferred<void>();
    const allowRegistration = deferred<void>();
    const order: string[] = [];
    const snapshots: AgentRunCapabilitySnapshot[] = [];
    const active = new Set<string>();
    let requests = 0;
    let started = false;
    const agent = await fixture({
      onRunCapabilities: async snapshot => {
        snapshots.push(snapshot);
        order.push("register");
        active.add(snapshot.scope.runId);
        entered.resolve();
        await allowRegistration.promise;
        return async () => { order.push("release"); active.delete(snapshot.scope.runId); };
      },
      onEvent: event => { if (["run.started", "run.completed"].includes(event.type)) order.push(event.type); },
      client: { async *streamMessage() {
        requests++;
        expect(active.has("scope-run")).toBe(true);
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      } },
    });
    try {
      const run = agent.submitMessage("work", { capabilityView: agent.host.plugins.createRunCapabilityView("P"),
        ids: { inputId: "scope-input", runId: "scope-run", traceId: "scope-trace" },
        metadata: { identity: { childId: "forged" }, pluginCandidates: [candidates[1]] } });
      void run.started.then(() => { started = true; });
      await entered.promise;
      expect(started).toBe(false);
      expect(requests).toBe(0);
      expect(snapshots[0]).toMatchObject({ scope: { sessionId: agent.id, runId: "scope-run" }, pluginCandidates: [candidates[0]] });
      expect(snapshots[0]!.identity).toBeUndefined();
      expect([...snapshots[0]!.capabilityView.tools.keys()]).toEqual(["PluginP"]);
      allowRegistration.resolve();
      await run.result;
      expect(started).toBe(true);
      expect(requests).toBe(1);
      expect(order).toEqual(["run.started", "register", "run.completed", "release"]);
      expect(active.size).toBe(0);
    } finally { allowRegistration.resolve(); await agent.close(); }
  });

  it.each(["run.started", "output.text.delta", "run.completed"])("does not retain a scope when the reliable %s sink rejects", async failingEvent => {
    const active = new Set<string>();
    let registered = 0;
    let released = 0;
    let requests = 0;
    const agent = await fixture({
      onEvent: event => { if (event.type === failingEvent) throw new Error("durable sink failed"); },
      onRunCapabilities: snapshot => {
        registered++; active.add(snapshot.scope.runId);
        return () => { released++; active.delete(snapshot.scope.runId); };
      },
      client: { async *streamMessage() {
        requests++;
        yield { type: "text_delta" as const, delta: "reply" };
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      } },
    });
    try {
      await expect(agent.runMessage("work")).rejects.toThrow("durable sink failed");
      expect(registered).toBe(failingEvent === "run.started" ? 0 : 1);
      expect(released).toBe(registered);
      expect(requests).toBe(failingEvent === "run.started" ? 0 : 1);
      expect(active.size).toBe(0);
    } finally { await agent.close(); }
  });

  it("fails closed if host registration rejects, without invoking an uninitialized release", async () => {
    const terminal: string[] = [];
    let requests = 0;
    const agent = await fixture({
      onRunCapabilities: async () => { throw new Error("scope registration failed"); },
      onEvent: event => { if (["run.failed", "run.completed"].includes(event.type)) terminal.push(event.type); },
      client: { async *streamMessage() { requests++; yield { type: "complete" as const, stopReason: "end_turn" as const }; } },
    });
    try {
      const run = agent.submitMessage("work");
      await expect(run.started).rejects.toThrow("scope registration failed");
      await expect(run.result).rejects.toThrow("scope registration failed");
      expect(requests).toBe(0);
      expect(terminal).toEqual(["run.failed"]);
    } finally { await agent.close(); }
  });

  it("releases after interruption during asynchronous registration and never dispatches the model", async () => {
    const entered = deferred<void>();
    const allowRegistration = deferred<void>();
    const order: string[] = [];
    const signal = new AbortController();
    let requests = 0;
    const agent = await fixture({
      onRunCapabilities: async () => { entered.resolve(); await allowRegistration.promise; return () => { order.push("release"); }; },
      onEvent: event => { if (event.type === "run.interrupted") order.push(event.type); },
      client: { async *streamMessage() { requests++; yield { type: "complete" as const, stopReason: "end_turn" as const }; } },
    });
    try {
      const run = agent.submitMessage("work", { signal: signal.signal });
      await entered.promise;
      signal.abort(new Error("interrupted registration"));
      allowRegistration.resolve();
      await expect(run.result).rejects.toThrow("interrupted registration");
      await expect(run.started).rejects.toThrow("interrupted registration");
      expect(requests).toBe(0);
      expect(order).toEqual(["run.interrupted", "release"]);
    } finally { allowRegistration.resolve(); await agent.close(); }
  });

  it("reports host release failure without forging a second terminal event", async () => {
    const terminal: string[] = [];
    let released = 0;
    const agent = await fixture({
      onRunCapabilities: () => async () => { released++; throw new Error("release failed"); },
      onEvent: event => { if (["run.failed", "run.completed"].includes(event.type)) terminal.push(event.type); },
    });
    try {
      await expect(agent.runMessage("work")).rejects.toThrow("release failed");
      expect(terminal).toEqual(["run.completed"]);
      expect(released).toBe(1);
    } finally { await agent.close(); }
  });

  it("registers through the default Node assembly without exposing the host callback as a tool", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vykor-run-scope-"));
    const active: AgentRunCapabilitySnapshot[] = [];
    let released = false;
    const agent = await createDefaultNodeAgent({ cwd, settings, internalTextOnly: true,
      onRunCapabilities: snapshot => { active.push(snapshot); return () => { released = true; }; },
      client: { async *streamMessage(params) {
        expect(active).toHaveLength(1);
        expect(params.tools ?? []).toEqual([]);
        yield { type: "complete" as const, stopReason: "end_turn" as const };
      } },
    });
    try { await agent.runMessage("work"); expect(released).toBe(true); }
    finally { await agent.close(); rmSync(cwd, { recursive: true, force: true }); }
  });

  it("inherits the host callback through child and grandchild Runs and re-registers a suspended child with its captured scope", async () => {
    const snapshots: AgentRunCapabilitySnapshot[] = [];
    const released = new Set<string>();
    const active = new Set<string>();
    const events: AgentEvent[] = [];
    let childController: AgentChildController | undefined;
    let childId: string | undefined;
    let rootTurns = 0;
    const turns = new Map<string, number>();
    const agent = await fixture({ childIdleTtlMs: 5,
      onRunCapabilities: snapshot => {
        snapshots.push(snapshot); active.add(snapshot.scope.runId);
        return () => { released.add(snapshot.scope.runId); active.delete(snapshot.scope.runId); };
      },
      onEvent: event => { events.push(event); },
      createClient: context => ({ async *streamMessage() {
        const turn = (turns.get(context.sessionId!) ?? 0) + 1;
        turns.set(context.sessionId!, turn);
        const isGrandchild = context.configuration.systemPrompt === "grandchild";
        if (!context.identity) rootTurns++;
        const delegate = !isGrandchild && turn === 1;
        if (delegate) yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: `delegate-${context.sessionId}`, name: "Delegate", input: {} } };
        yield { type: "complete" as const, stopReason: delegate ? "tool_use" as const : "end_turn" as const };
      } }),
      delegate: async (context, controller) => {
        const grandchild = Boolean(context.identity);
        const child = await controller.spawnChildAgent({ description: grandchild ? "grandchild" : "worker", prompt: "work", agent: "worker",
          cwd: context.cwd, systemPrompt: grandchild ? "grandchild" : "worker", allowedTools: grandchild ? ["PluginP"] : ["Delegate", "PluginP"] });
        if (!grandchild) { childController = controller; childId = child.id; }
        await child.result;
      },
    });
    try {
      await agent.runMessage("delegate", { capabilityView: agent.host.plugins.createRunCapabilityView("P") });
      expect(snapshots).toHaveLength(3);
      const childSnapshot = snapshots.find(snapshot => snapshot.identity?.parentSessionId === agent.id)!;
      const grandchildSnapshot = snapshots.find(snapshot => snapshot.identity?.parentSessionId === childSnapshot.scope.sessionId)!;
      expect(grandchildSnapshot.identity?.parentRunId).toBe(childSnapshot.scope.runId);
      expect([...grandchildSnapshot.capabilityView.tools.keys()]).toEqual(["PluginP"]);
      expect(snapshots.every(snapshot => snapshot.pluginCandidates.length === 1 && snapshot.pluginCandidates[0]!.pluginId === "P")).toBe(true);
      await vi.waitFor(() => expect(events.some(event => event.type === "child.suspended" && event.context.childId === childId)).toBe(true));
      await childController!.sendChildInput(childId!, { content: "continue", delivery: "queue" });
      await childController!.awaitChildAgent(childId!);
      expect(snapshots).toHaveLength(4);
      const resumed = snapshots.at(-1)!;
      expect(resumed.scope.sessionId).toBe(childSnapshot.scope.sessionId);
      expect(resumed.identity?.parentRunId).toBe(snapshots[0]!.scope.runId);
      expect(resumed.scope.runId).not.toBe(childSnapshot.scope.runId);
      expect(resumed.pluginCandidates).toEqual([candidates[0]]);
      expect([...resumed.capabilityView.tools.keys()]).toEqual(["Delegate", "PluginP"]);
      expect(active.size).toBe(0);
      expect(released.size).toBe(4);
      expect(rootTurns).toBe(2);
    } finally { await agent.close(); }
  });
});

async function fixture(options: {
  onRunCapabilities?: VykorAgentConfiguration["onRunCapabilities"];
  onEvent?: (event: AgentEvent) => void;
  client?: StreamingMessageClient;
  childIdleTtlMs?: number;
  createClient?: (context: AgentKernelRuntimeContext) => StreamingMessageClient;
  delegate?: (context: AgentKernelRuntimeContext, controller: AgentChildController) => Promise<void>;
} = {}) {
  const capabilities: ResolvedAgentCapabilities = {
    terminal: unavailableCapability("test"), backgroundShell: unavailableCapability("test"), jobs: unavailableCapability("test"),
    memory: unavailableCapability("test"), workflowRepository: unavailableCapability("test"), schedules: unavailableCapability("test"),
    childEnvironment: { status: "available", source: "override", value: createInProcessChildEnvironmentProvider() },
  };
  return await createAgentKernel({ settings, cwd: "D:/workspace", sessionId: "root-lifecycle", capabilities,
    configuration: { onRunCapabilities: options.onRunCapabilities },
    effects: { requestPermission: async () => ({ status: "approved" }) }, onEvent: options.onEvent, childIdleTtlMs: options.childIdleTtlMs,
    createRuntime: async context => {
      const prepared = createBasicAgentKernelRuntime({ settings, cwd: context.cwd, sessionId: context.sessionId,
        client: options.createClient?.(context) ?? options.client ?? { async *streamMessage() { yield { type: "complete" as const, stopReason: "end_turn" as const }; } },
        tools: options.delegate ? [{ name: "Delegate", description: "delegate", inputSchema: { type: "object" },
          execute: async (_input, toolContext) => { await options.delegate!(context, toolContext.agent!.children!); return { content: [] }; } }] : [],
      });
      for (const id of ["P", "Q"]) prepared.runtime.toolRegistry.register({ name: `Plugin${id}`, description: id,
        inputSchema: { type: "object" }, execute: async () => ({ content: [] }) }, { kind: "plugin", id });
      prepared.runtime.createRunCapabilityView = scope => createRunCapabilityView({ toolRegistry: prepared.runtime.toolRegistry, pluginIds: new Set(["P", "Q"]) }, scope);
      return { ...prepared, pluginSelection: { candidates, validate: async () => {} } };
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
