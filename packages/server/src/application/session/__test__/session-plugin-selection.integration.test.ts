import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryEngine, ToolRegistry, type AgentExecutionContext, type Message, type RunCapabilityView, type StreamMessageParams } from "@vykor/core";
import { toolSearchTool } from "@vykor/tools";
import { createRunCapabilityView, type PluginCapabilityInventory } from "@vykor/agent-runtime";
import { SessionStore } from "@vykor/services";
import type { SessionInputRecord, SessionRunRecord } from "@vykor/protocol";
import { DaemonOperationGate } from "../../control/daemon-operation-gate.js";
import { RunAdmissionService } from "../run-admission-service.js";
import { SessionInteractionService } from "../session-interaction-service.js";
import { SessionPluginCapabilityService } from "../session-plugin-capability-service.js";
import { resolveRunPluginSelection } from "../session-plugin-selection.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

function fixture(delivery: "unmerged" | "recovered" | "same" = "unmerged", discovery = false) {
  const directory = mkdtempSync(join(tmpdir(), "vk-plugin-selection-"));
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.sessions.create({ id: "s1", cwd: directory, model: "test" });
  let activeRun: SessionRunRecord | undefined;
  const events = { checkpoint: () => 0, publishSince() {} };
  const admission: RunAdmissionService = new RunAdmissionService({
    conversationTransactions: {
      admitPrompt: (input, config) => store.conversationTransactions.admitPrompt(input, config),
      admitPromptWithRun: (input, config) => store.conversationTransactions.admitPromptWithRun(input, config),
      replaceTranscriptAndAdmitPrompt: input => store.conversationTransactions.replaceTranscriptAndAdmitPrompt({ ...input, createRun: input.createRun ?? false }),
      replaceLatestPromptWithAdmission: input => store.conversationTransactions.replaceLatestPromptWithAdmission({ ...input, createRun: input.createRun ?? false }),
      getInput: id => store.conversations.getInput(id),
    },
    runOperations: {
      createRun: input => store.runs.createRun(input), getRun: id => store.runs.getRun(id),
      findRunByInput: id => store.runs.findRunByInput(id), updateRun: (id, patch) => store.runs.updateRun(id, patch),
      createReplayRun: (id, input) => store.conversationTransactions.createReplayRun(id, input),
    }, events,
    runtimeQueue: {
      hasRuntime: true, enqueueRun: () => "queued",
      steer: (_sessionId, input) => {
        if (delivery === "unmerged") return { merged: false };
        const runId = delivery === "recovered" ? admission.recoverRejectedSteer("s1", input) : activeRun!.id;
        return { merged: true, activeRunId: activeRun!.id, delivery: Promise.resolve({ runId }) };
      },
    },
  });
  const inventory: PluginCapabilityInventory = {
    plugins: new Map(["P", "Q"].map(pluginId => [pluginId, {
      pluginId, displayName: pluginId, description: pluginId, version: "1", behaviorDigest: `${pluginId}-digest`,
      scope: "user", origin: "native", skillNames: [], mcpServerIds: [], nativeToolEntries: [], agentNames: [],
    }])),
    skills: new Map(), agents: new Map(), mcpServers: new Map(), nativeToolEntries: new Map(), diagnostics: [],
  };
  const application = new SessionInteractionService({
    sessions: store.sessions, conversations: store.conversations, runs: store.runs, admission,
    operationRunner: { run: async (_id, work) => work() },
    control: { activeRunId: () => activeRun?.id, hasWork: () => false } as never,
    agentPool: { configured: true, close: async () => {}, warm: async () => {} } as never,
    liveChildren: { has: () => false, send: async () => undefined, interrupt: async () => {} } as never,
    operationGate: new DaemonOperationGate(),
    pluginCapabilities: new SessionPluginCapabilityService({ resolveInventory: async () => inventory }),
  });
  const selectPluginForRun = vi.fn(async () => ({ pluginId: "P", reason: "matched" as const, version: "1", behaviorDigest: "P-digest" }));
  const candidates = () => [...inventory.plugins.values()].map(({ pluginId, displayName, description, version, behaviorDigest }) =>
    ({ pluginId, displayName, description, version, behaviorDigest }));
  const validatePluginScope = async (selected: ReturnType<typeof candidates>) => {
    for (const candidate of selected) {
      const current = inventory.plugins.get(candidate.pluginId);
      if (!current || current.version !== candidate.version || current.behaviorDigest !== candidate.behaviorDigest)
        throw new Error(`Plugin changed or disabled: ${candidate.pluginId}`);
    }
  };
  const registry = new ToolRegistry();
  const invoked: string[] = [];
  for (const name of ["Public", "P", "Q"]) registry.register({ name, description: name, inputSchema: {}, execute: async () => { invoked.push(name); return { content: [] }; } },
    name === "Public" ? { kind: "builtin" } : { kind: "plugin", id: name });
  if (discovery) registry.register(toolSearchTool, { kind: "builtin" });
  return {
    store, application, selectPluginForRun, inventory, invoked,
    startAutomaticRun() {
      activeRun = store.runs.createRun({ sessionId: "s1", metadata: { pluginSelection: {
        status: "resolved", source: "auto", scopeVersion: 2, pluginId: null, pluginIds: ["P", "Q"], candidates: candidates(), reason: "matched",
      } } });
      activeRun = store.runs.updateRun(activeRun.id, { status: "running" });
      return activeRun;
    },
    async resolve(result: { input: SessionInputRecord; run?: SessionRunRecord }) {
      const selection = await resolveRunPluginSelection({ session: store.sessions.get("s1")!, input: result.input, run: result.run!,
        agent: { getPluginCandidates: candidates, validatePluginScope }, signal: new AbortController().signal, traceId: "test" });
      const view = createRunCapabilityView({ toolRegistry: registry, pluginIds: new Set(["P", "Q"]) },
        selection.scopeVersion === 2 ? selection.pluginIds : selection.pluginId ?? undefined);
      return { selection, tools: [...view.tools.keys()], view };
    },
    ordinary: (id: string, delivery: "queue" | "steer" = "queue") => application.admitPrompt("s1", { id, delivery, items: [{ type: "text", text: "do this task" }] }),
    mention: (pluginId: string) => application.admitPrompt("s1", { id: `mention-${pluginId}`, items: [{ type: "capability", kind: "plugin", pluginId, displayName: pluginId }] }),
  };
}

// Exercises the real discovery/execution pipeline against the scope produced by admission/recovery.
async function runWithSearch(view: RunCapabilityView, script: Array<{ name: string; input?: Record<string, unknown> }>, history: Message[] = []) {
  const requests: StreamMessageParams[] = [];
  const engine = new QueryEngine({ async *streamMessage(params) {
    const step = script[requests.length];
    requests.push({ ...params, messages: structuredClone(params.messages) });
    if (step) yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: `search-test-${requests.length}`, input: {}, ...step } };
    yield { type: "complete" as const, stopReason: step ? "tool_use" : "end_turn" };
  } }, new ToolRegistry(), { checkTool: async () => ({ action: "allow" }) },
  { register() {}, execute: async () => ({ blocked: false }) }, { toolDiscovery: {
    searchTool: toolSearchTool, minToolCount: 1, shouldDefer: (_tool, source) => source?.kind === "plugin",
  } });
  engine.loadMessages(history);
  const execution = { capabilityView: view, scope: { runId: "discovery-test", signal: new AbortController().signal },
    effects: { requestPermission: async () => ({ status: "denied" }) },
    emit: async () => {}, takeSteeredInputs: async () => [], closeSteering() {},
  } as unknown as AgentExecutionContext;
  const results = [];
  for await (const event of engine.submitMessage("task", { execution })) if (event.type === "tool_use_end") results.push(event.result);
  return { requests, results, history: engine.getHistory() };
}

describe("plugin selection across admission, queue and recovery", () => {
  it.each(["unmerged", "recovered"] as const)("keeps ToolSearch within a promoted steer's captured scope after a later @ (%s)", async delivery => {
    const f = fixture(delivery, true);
    f.startAutomaticRun();
    const queued = await f.ordinary("search-steer", "steer");
    await f.mention("Q");
    const captured = await f.resolve(queued);
    const run = await runWithSearch(captured.view, [{ name: "ToolSearch", input: { query: "P", limit: 1 } }, { name: "P" }]);
    expect(captured.selection).toMatchObject({ source: "auto", pluginIds: ["P", "Q"] });
    expect(run.requests[0]!.tools?.map(t => t.name)).toEqual(["Public", "ToolSearch"]);
    expect(run.requests[1]!.tools?.map(t => t.name)).toContain("P");
    expect(f.invoked).toEqual(["P"]);
    expect(f.store.sessions.get("s1")!.metadata.activePluginId).toBe("Q");
    const inherited = await f.resolve(await f.ordinary("after-search"));
    const limited = await runWithSearch(inherited.view, [{ name: "ToolSearch", input: { query: "P" } }, { name: "P" }]);
    expect(limited.requests.flatMap(r => r.tools?.map(t => t.name) ?? [])).not.toContain("P");
    expect(limited.results[1]).toMatchObject({ isError: true, executionState: "not_started" });
    expect(f.invoked).toEqual(["P"]);
  });

  it("cold recovery searches the saved scope again without replaying settled calls and rejects disabled sources", async () => {
    const f = fixture("unmerged", true);
    const earlier = await f.ordinary("search-before-interruption");
    const captured = await f.resolve(earlier);
    const first = await runWithSearch(captured.view, [{ name: "ToolSearch", input: { query: "P", limit: 1 } }, { name: "P" }]);
    f.store.runs.updateRun(earlier.run!.id, { status: "interrupted", metadata: { pluginSelection: captured.selection } });
    await f.mention("Q");
    const replay = await f.application.resumeRun("s1", earlier.run!.id, { id: "search-replay", traceId: "replay" });
    const recovered = await f.resolve(replay);
    const next = await runWithSearch(recovered.view, [{ name: "ToolSearch", input: { query: "Q", limit: 1 } }, { name: "Q" }], first.history);
    expect(next.requests[0]!.tools?.map(t => t.name)).not.toContain("P");
    expect(next.requests[0]!.tools?.map(t => t.name)).not.toContain("Q");
    expect(next.requests[0]!.messages.some(m => m.type === "tool_result")).toBe(true);
    expect(f.invoked).toEqual(["P", "Q"]);
    expect(recovered.selection).toMatchObject({ pluginIds: ["P", "Q"] });
    (f.inventory.plugins as Map<string, unknown>).delete("P");
    await expect(f.resolve(replay)).rejects.toThrow("Plugin changed or disabled: P");
    expect(f.invoked).toEqual(["P", "Q"]);
  });

  it.each(["unmerged", "recovered"] as const)("does not inherit an automatic plugin when a steer becomes a new Run (%s)", async delivery => {
    const f = fixture(delivery);
    const active = f.startAutomaticRun();
    const result = await f.ordinary("follow-up", "steer");
    expect(result.run!.id).not.toBe(active.id);
    expect(await f.resolve(result)).toMatchObject({ selection: { pluginIds: ["P", "Q"], source: "auto" }, tools: ["Public", "P", "Q"] });
    expect(f.selectPluginForRun).not.toHaveBeenCalled();
    expect(result.input.metadata).not.toHaveProperty("pluginId");
    expect(result.run!.metadata).not.toHaveProperty("pluginId");
    expect(f.store.sessions.get("s1")!.metadata).not.toHaveProperty("activePluginId");
  });

  it("keeps a delivered steer in the current automatic Run without pinning its plugin on the Input", async () => {
    const f = fixture("same");
    const active = f.startAutomaticRun();
    const result = await f.ordinary("same-run", "steer");
    expect(result.run).toMatchObject({ id: active.id, metadata: { pluginSelection: { pluginIds: ["P", "Q"] } } });
    expect(result.input.metadata).not.toHaveProperty("pluginId");
    expect(f.selectPluginForRun).not.toHaveBeenCalled();
  });

  it("keeps an earlier queued automatic turn independent of a later @ and preserves subsequent manual inheritance", async () => {
    const f = fixture();
    const earlier = await f.ordinary("earlier");
    const explicit = await f.mention("Q");
    expect(f.store.sessions.get("s1")!.metadata.activePluginId).toBe("Q");
    const retry = await f.ordinary("earlier");
    expect(retry.run!.id).toBe(earlier.run!.id);
    expect(await f.resolve(earlier)).toMatchObject({ selection: { pluginIds: ["P", "Q"], source: "auto" }, tools: ["Public", "P", "Q"] });
    expect(await f.resolve(explicit)).toMatchObject({ selection: { pluginId: "Q", source: "explicit" }, tools: ["Public", "Q"] });
    expect(await f.resolve(await f.ordinary("after-mention"))).toMatchObject({ selection: { pluginId: "Q", source: "inherited" } });
    expect(f.selectPluginForRun).not.toHaveBeenCalled();
  });

  it("preserves automatic eligibility when replaying an interrupted queued turn after a later @", async () => {
    const f = fixture();
    const earlier = await f.ordinary("interrupted-before-selection");
    f.store.runs.updateRun(earlier.run!.id, { status: "interrupted" });
    const later = await f.mention("Q");
    f.store.runs.updateRun(later.run!.id, { status: "completed" });
    const replay = await f.application.resumeRun("s1", earlier.run!.id, { id: "replay", traceId: "replay" });
    expect(await f.resolve(replay)).toMatchObject({ selection: { pluginIds: ["P", "Q"], source: "auto" }, tools: ["Public", "P", "Q"] });
  });

  it("still checks disabled plugins at execution even when automatic selection was allowed at admission", async () => {
    const f = fixture();
    const earlier = await f.ordinary("disable-later");
    f.store.sessions.update("s1", { metadata: { runtime: { pluginsEnabled: false } } });
    expect(await f.resolve(earlier)).toMatchObject({ selection: { pluginId: null }, tools: ["Public"] });
    expect(f.selectPluginForRun).not.toHaveBeenCalled();
  });

  it("does not turn a queued no-auto message into automatic selection when preferences later change", async () => {
    const f = fixture();
    f.store.sessions.update("s1", { metadata: { runtime: { pluginAutoSelectionEnabled: false } } });
    const earlier = await f.ordinary("auto-was-off");
    f.store.sessions.update("s1", { metadata: { runtime: { pluginAutoSelectionEnabled: true } } });
    expect(await f.resolve(earlier)).toMatchObject({ selection: { pluginId: null }, tools: ["Public"] });
    expect(f.selectPluginForRun).not.toHaveBeenCalled();
  });

  it("keeps a queued automatic scope after automatic selection is switched off", async () => {
    const f = fixture();
    const earlier = await f.ordinary("auto-captured");
    f.store.sessions.update("s1", { metadata: { runtime: { pluginAutoSelectionEnabled: false } } });
    await f.mention("Q");
    expect(await f.resolve(earlier)).toMatchObject({ selection: { pluginIds: ["P", "Q"], source: "auto" }, tools: ["Public", "P", "Q"] });
  });

  it("keeps an already inherited manual plugin after a later @ switches the session", async () => {
    const f = fixture();
    await f.mention("P");
    const earlier = await f.ordinary("manual-before-switch");
    await f.mention("Q");
    expect(await f.resolve(earlier)).toMatchObject({ selection: { pluginId: "P", source: "inherited" }, tools: ["Public", "P"] });
    expect(f.selectPluginForRun).not.toHaveBeenCalled();
  });

  it.each(["auto", "none"])("ignores caller-forged admission policy %s", async policy => {
    const f = fixture();
    const earlier = await f.application.admitPrompt("s1", { id: "forged-policy", items: [{ type: "text", text: "task" }],
      metadata: { pluginSelectionPolicy: policy }, runMetadata: { pluginSelectionPolicy: policy } });
    await f.mention("Q");
    expect(await f.resolve(earlier)).toMatchObject({ selection: { pluginIds: ["P", "Q"], source: "auto" }, tools: ["Public", "P", "Q"] });
  });

  it("does not let caller metadata enable automatic selection when it was disabled at admission", async () => {
    const f = fixture();
    f.store.sessions.update("s1", { metadata: { runtime: { pluginAutoSelectionEnabled: false } } });
    const earlier = await f.application.admitPrompt("s1", { id: "forge-auto-on", items: [{ type: "text", text: "task" }],
      metadata: { pluginSelectionPolicy: "auto" }, runMetadata: { pluginSelectionPolicy: "auto" } });
    expect(await f.resolve(earlier)).toMatchObject({ selection: { pluginId: null }, tools: ["Public"] });
    expect(f.selectPluginForRun).not.toHaveBeenCalled();
  });

  it("captures only plugins available at admission and ignores forged scope metadata", async () => {
    const f = fixture();
    (f.inventory.plugins as Map<string, unknown>).delete("Q");
    const earlier = await f.application.admitPrompt("s1", { id: "before-install", items: [{ type: "text", text: "task" }],
      metadata: { pluginScope: { scopeVersion: 2, source: "auto", pluginIds: ["Q"], candidates: [] } },
      runMetadata: { pluginScope: { scopeVersion: 2, source: "auto", pluginIds: ["Q"], candidates: [] } } });
    (f.inventory.plugins as Map<string, unknown>).set("Q", { ...f.inventory.plugins.get("P"), pluginId: "Q", behaviorDigest: "Q-digest" });
    expect(earlier.input.metadata).toMatchObject({ pluginScope: { scopeVersion: 2, pluginIds: ["P"] } });
    expect(earlier.run!.metadata).not.toHaveProperty("pluginScope");
    expect(await f.resolve(earlier)).toMatchObject({ selection: { pluginIds: ["P"] }, tools: ["Public", "P"] });
  });

  it("keeps the resolved multi-plugin scope through recovery and rejects changed sources", async () => {
    const f = fixture();
    const earlier = await f.ordinary("resolved-before-interruption");
    const { selection } = await f.resolve(earlier);
    f.store.runs.updateRun(earlier.run!.id, { status: "interrupted", metadata: { pluginSelection: selection } });
    await f.mention("Q");
    const replay = await f.application.resumeRun("s1", earlier.run!.id, { id: "strict-replay", traceId: "replay" });
    expect(replay.run!.metadata).toMatchObject({ pluginSelection: { pluginIds: ["P", "Q"] } });
    (f.inventory.plugins as Map<string, unknown>).delete("P");
    await expect(f.resolve(replay)).rejects.toThrow("Plugin changed or disabled: P");
  });
});
