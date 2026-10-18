import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { expect, it } from "vitest";
import { ToolRegistry, type RunPluginUiBinding, type Settings, type ToolDefinition } from "@vykor/core";
import { createRunCapabilityView, type VykorAgent } from "@vykor/agent-runtime";
import { createAgentKernel, createBasicAgentKernelRuntime } from "../../../../../agent-runtime/src/kernel.js";
import { createInProcessChildEnvironmentProvider } from "../../../../../agent-runtime/src/child-environment.js";
import { unavailableCapability } from "../../../../../agent-runtime/src/capability-resolution.js";
import { SessionStore } from "@vykor/services";
import { ChildAgentExecutionRegistry } from "@vykor/services/executions";
import { readPluginUiInstance } from "@vykor/protocol";
import { DaemonAgentEventProjector } from "../../agent/daemon-agent-event-projector.js";
import { SessionExecutionProjector } from "../session-execution-projector.js";
import { SessionTranscriptProjection } from "../transcript-projection.js";
import { SessionPluginUiService } from "../session-plugin-ui-service.js";
import { SessionPluginUiConversationService } from "../session-plugin-ui-conversation-service.js";
import { SessionPluginCapabilityService } from "../session-plugin-capability-service.js";
import { SessionOperationRunner } from "../session-operation-runner.js";
import { RunAdmissionService } from "../run-admission-service.js";
import { DaemonOperationGate } from "../../control/daemon-operation-gate.js";

it.each([false, true])("projects an actual worker card and hands it back to the Coordinator (relative cwd=%s)", async relativeCwd => {
  const directory = mkdtempSync(join(relativeCwd ? process.cwd() : tmpdir(), "vykor-child-ui-closed-loop-"));
  const path = join(directory, "session.db");
  let store = new SessionStore({ path });
  let agent: VykorAgent | undefined;
  try {
    const session = store.sessions.create({ id: "ui-coordinator", cwd: directory, model: "script-only",
      metadata: { runtime: { model: "script-only", sessionMode: "coordinator" } } });
    const input = store.conversationTransactions.admitPrompt({ id: "ui-input", sessionId: session.id, content: "delegate" });
    const candidate = { pluginId: "example.worker-ui", displayName: "Worker UI", description: "Inspect", version: "1.0.0", behaviorDigest: "a".repeat(64) };
    store.runs.createRun({ id: "ui-run", sessionId: session.id, inputId: input.id, metadata: { pluginId: null,
      pluginSelection: { status: "resolved", scopeVersion: 2, source: "auto", pluginId: null, reason: "matched",
        pluginIds: [candidate.pluginId], candidates: [candidate] } } });
    const inspect: ToolDefinition = { name: "Inspect", description: "Inspect", inputSchema: { type: "object" },
      execute: async () => ({ content: [{ type: "text", text: "Found one issue" }],
        metadata: { ui: { schemaVersion: 2, componentId: "panel", data: { count: 1 } } } }) };
    const registry = new ToolRegistry(); registry.register(inspect, { kind: "plugin", id: candidate.pluginId });
    const action = createRunCapabilityView({ toolRegistry: registry, pluginIds: new Set([candidate.pluginId]) }, candidate.pluginId).tools.get("Inspect")!;
    const binding: RunPluginUiBinding = { pluginId: candidate.pluginId, pluginVersion: candidate.version, pluginDigest: candidate.behaviorDigest,
      componentId: "panel", componentDigest: "b".repeat(64), htmlSha256: "c".repeat(64), root: directory, entryPath: join(directory, "panel.html"),
      definition: { id: "panel", title: "Worker panel", entry: "panel.html", surface: "tool-result",
        actions: [{ id: "inspect", label: "Inspect", tool: "Inspect", completion: "keep-open" }] }, actionTools: [action] };
    const { actionTools: _actionTools, ...documentBinding } = binding;
    const makeSource = () => new SessionPluginUiService({ store, transaction: work => store.transaction(work),
      verifySourceBinding: async value => value === binding || value.pluginDigest === binding.pluginDigest,
      resolveCurrent: async () => ({ enabled: true, uiEnabled: true, permissionsApproved: true,
        snapshot: "valid", documentBinding, runtimeAvailable: false }) });
    let source = makeSource();
    const runAuthorization = new SessionPluginCapabilityService({ store, resolveInventory: async () => { throw new Error("No rediscovery during Run capture"); } });
    const events = { checkpoint: () => 0, publish: () => {}, publishSince: () => {} };
    const registryHost = new ChildAgentExecutionRegistry();
    const executionProjector = new SessionExecutionProjector({ store, events, getChildAgentExecutionRegistry: () => registryHost,
      traceIdForRun: id => id, log: () => {} });
    let projector: DaemonAgentEventProjector;
    const settings: Settings = { model: "script-only", apiFormat: "anthropic", maxTurns: 3, permission: { mode: "default" } };
    const snapshots: Array<{ child: boolean; cwd: string; storedCwd: string }> = [];
    const modelTools: Array<{ worker: boolean; names: string[] }> = [];
    const workerCwd = relativeCwd ? relative(process.cwd(), directory) : directory;
    expect(isAbsolute(workerCwd)).toBe(!relativeCwd);
    const delegate: ToolDefinition = { name: "Delegate", description: "Delegate", inputSchema: { type: "object" },
      execute: async (_input, context) => {
        const child = await context.agent!.children.spawnChildAgent({ agent: "worker", description: "inspect", prompt: "inspect", cwd: workerCwd });
        const result = await child.result;
        expect(result.status).toBe("completed");
        return { content: [{ type: "text", text: result.output }] };
      } };
    agent = await createAgentKernel({ cwd: directory, sessionId: session.id, settings,
      configuration: { onRunCapabilities: snapshot => {
        snapshots.push({ child: Boolean(snapshot.identity?.childId), cwd: snapshot.scope.cwd,
          storedCwd: store.sessions.get(snapshot.scope.sessionId)!.cwd });
        runAuthorization.authorizeRun(snapshot);
        if (snapshot.capabilityView.pluginUi?.size) return source.registerRunView(snapshot.scope.runId, snapshot.capabilityView);
      } }, effects: { requestPermission: async () => ({ status: "approved" }) },
      capabilities: { terminal: unavailableCapability("test"), backgroundShell: unavailableCapability("test"),
        jobs: unavailableCapability("test"), memory: unavailableCapability("test"), workflowRepository: unavailableCapability("test"),
        schedules: unavailableCapability("test"), childEnvironment: { status: "available", source: "override", value: createInProcessChildEnvironmentProvider() } },
      onEvent: event => projector.apply(event),
      createRuntime: async context => {
        const worker = Boolean(context.identity?.childId);
        const prepared = createBasicAgentKernelRuntime({ cwd: context.cwd, sessionId: context.sessionId, settings,
          tools: worker ? [] : [delegate], client: { async *streamMessage(request) {
            modelTools.push({ worker, names: request.tools?.map(tool => tool.name) ?? [] });
            if (request.messages.at(-1)?.type === "user") {
              yield { type: "tool_use_start", toolUse: { type: "tool_use", id: worker ? "inspect-call" : "delegate-call", name: worker ? "Inspect" : "Delegate", input: {} } };
              yield { type: "complete", stopReason: "tool_use" };
            } else {
              yield { type: "text_delta", delta: "done" };
              yield { type: "complete", stopReason: "end_turn" };
            }
          } } });
        if (worker) prepared.runtime.toolRegistry.register(inspect, { kind: "plugin", id: candidate.pluginId });
        prepared.runtime.createRunCapabilityView = scope => createRunCapabilityView({ toolRegistry: prepared.runtime.toolRegistry,
          delegatableToolRegistry: registry, pluginIds: new Set([candidate.pluginId]), pluginUi: [binding] }, scope);
        return { ...prepared, pluginSelection: { candidates: [candidate], validate: async () => {} } };
      },
    });
    projector = new DaemonAgentEventProjector({ store, rootAgent: agent, events, executionProjector,
      transcriptProjection: new SessionTranscriptProjection(store, source), pluginUi: source,
      liveChildren: { register: () => {}, unregister: () => {} }, log: () => {} });
    await agent.runMessage("delegate", { ids: { inputId: input.id, runId: "ui-run", traceId: "ui-trace" } });
    expect(modelTools.filter(item => !item.worker).every(item => !item.names.includes("Inspect"))).toBe(true);
    expect(modelTools.some(item => item.worker && item.names.includes("Inspect"))).toBe(true);
    const childSession = store.sessions.list({ includeArchived: true }).find(value => value.parentId === session.id)!;
    expect(childSession.metadata.childId).toBeTypeOf("string");
    const part = store.conversations.listMessageParts(childSession.id).find(value => value.toolName === "Inspect")!;
    const instance = readPluginUiInstance(part.metadata)!;
    expect(instance).toMatchObject({ sessionId: childSession.id, pluginId: candidate.pluginId, sourceToolUseId: "inspect-call" });
    expect(store.runs.getRun(instance.sourceRunId)?.metadata).toMatchObject({ parentRunId: "ui-run", pluginId: null,
      pluginSelection: { candidates: [candidate] } });
    expect(snapshots).toHaveLength(2);
    await agent.close(); agent = undefined;
    store.close(); store = new SessionStore({ path }); source = makeSource();
    expect((await source.get(childSession.id, instance.instanceId)).availability).toEqual({ code: "runtime-unavailable", canRender: true, canInvoke: false });
    const operations = new SessionOperationRunner({ sessions: store.sessions, events, operationGate: new DaemonOperationGate() });
    const admission = new RunAdmissionService({ conversationTransactions: store.conversationTransactions, runOperations: store.runs, events,
      runtimeQueue: { hasRuntime: true, enqueueRun: () => "queued", steer: () => ({ merged: false }) } });
    const pluginCapabilities = new SessionPluginCapabilityService({ resolveInventory: async () => ({ plugins: new Map(), skills: new Map(), agents: new Map(),
      mcpServers: new Map(), nativeToolEntries: new Map(), diagnostics: [] }) });
    const conversation = new SessionPluginUiConversationService({ store, source, operations, admission, pluginCapabilities,
      modelAvailable: async targetId => targetId === session.id });
    const receipt = await conversation.submit(childSession.id, instance.instanceId, { requestId: "00000000-0000-0000-0000-000000000001",
      expectedRevision: 1, text: "Continue from the worker findings", data: { count: 1 } });
    expect(receipt.targetSessionId).toBe(session.id);
    expect(store.runs.getRun(receipt.runId)?.sessionId).toBe(session.id);
    expect(source.readConversationSource(childSession.id, instance.instanceId).instance.sessionId).toBe(childSession.id);
  } finally {
    await agent?.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps a host's ordinary child.send working without inventing a current parent Run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vykor-child-ui-host-followup-"));
  const store = new SessionStore({ path: join(directory, "session.db") });
  let agent: VykorAgent | undefined;
  try {
    const session = store.sessions.create({ id: "host-root", cwd: directory, model: "script-only",
      metadata: { runtime: { model: "script-only" } } });
    const input = store.conversationTransactions.admitPrompt({ id: "host-root-input", sessionId: session.id, content: "delegate" });
    store.runs.createRun({ id: "host-root-run", sessionId: session.id, inputId: input.id, metadata: { pluginId: null,
      pluginSelection: { status: "resolved", scopeVersion: 2, source: "none", pluginId: null, reason: "no_candidates", pluginIds: [], candidates: [] } } });
    const runAuthorization = new SessionPluginCapabilityService({ store, resolveInventory: async () => { throw new Error("No rediscovery during Run capture"); } });
    const source = new SessionPluginUiService({ store, transaction: work => store.transaction(work), resolveCurrent: async () => {
      throw new Error("No plugin UI was requested");
    } });
    const events = { checkpoint: () => 0, publish: () => {}, publishSince: () => {} };
    const registry = new ChildAgentExecutionRegistry();
    const executionProjector = new SessionExecutionProjector({ store, events, getChildAgentExecutionRegistry: () => registry,
      traceIdForRun: id => id, log: () => {} });
    let projector: DaemonAgentEventProjector;
    let childId = "", calls = 0;
    const count: ToolDefinition = { name: "Count", description: "Count", inputSchema: { type: "object" },
      execute: async () => ({ content: [{ type: "text", text: String(++calls) }] }) };
    const delegate: ToolDefinition = { name: "Delegate", description: "Delegate", inputSchema: { type: "object" },
      execute: async (_input, context) => {
        const child = await context.agent!.children.spawnChildAgent({ agent: "worker", description: "count", prompt: "count", cwd: directory });
        childId = child.id;
        return { content: [{ type: "text", text: (await child.result).output }] };
      } };
    const settings: Settings = { model: "script-only", apiFormat: "anthropic", maxTurns: 3, permission: { mode: "default" } };
    agent = await createAgentKernel({ cwd: directory, sessionId: session.id, settings,
      configuration: { onRunCapabilities: snapshot => runAuthorization.authorizeRun(snapshot) },
      effects: { requestPermission: async () => ({ status: "approved" }) },
      capabilities: { terminal: unavailableCapability("test"), backgroundShell: unavailableCapability("test"),
        jobs: unavailableCapability("test"), memory: unavailableCapability("test"), workflowRepository: unavailableCapability("test"),
        schedules: unavailableCapability("test"), childEnvironment: { status: "available", source: "override", value: createInProcessChildEnvironmentProvider() } },
      onEvent: event => projector.apply(event),
      createRuntime: async context => createBasicAgentKernelRuntime({ cwd: context.cwd, sessionId: context.sessionId, settings,
        tools: context.identity ? [count] : [delegate], client: { async *streamMessage(request) {
          if (request.messages.at(-1)?.type === "user") {
            yield { type: "tool_use_start", toolUse: { type: "tool_use", id: context.identity ? `count-${calls}` : "delegate", name: context.identity ? "Count" : "Delegate", input: {} } };
            yield { type: "complete", stopReason: "tool_use" };
          } else {
            yield { type: "text_delta", delta: "done" };
            yield { type: "complete", stopReason: "end_turn" };
          }
        } } }),
    });
    projector = new DaemonAgentEventProjector({ store, rootAgent: agent, events, executionProjector,
      transcriptProjection: new SessionTranscriptProjection(store, source), pluginUi: source,
      liveChildren: { register: () => {}, unregister: () => {} }, log: () => {} });
    await agent.runMessage("delegate", { ids: { inputId: input.id, runId: "host-root-run", traceId: "host-root-trace" } });
    expect(calls).toBe(1);
    const child = agent.children.get(childId)!;
    const receipt = await child.send({ content: "count again", metadata: { parentRunId: "forged", pluginId: "forged-plugin" } });
    await expect(child.result).resolves.toMatchObject({ status: "completed" });
    expect(calls).toBe(2);
    const run = store.runs.getRun(receipt.runId)!;
    expect(run.metadata).not.toHaveProperty("parentRunId");
    expect(run.metadata).toMatchObject({ pluginId: null, pluginSelection: { source: "none", pluginIds: [], candidates: [] } });
    expect(store.runs.getSessionTask(childId)).toMatchObject({ sessionId: session.id, childSessionId: child.sessionId, runId: receipt.runId });
  } finally {
    await agent?.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
