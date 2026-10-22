import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginCapabilityInventory, PluginCapabilityOwner } from "@vykor/agent-runtime";
import type { SessionUserInputItem } from "@vykor/domain-contracts/inputs";
import { SessionStore } from "@vykor/services";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonOperationGate } from "../../control/daemon-operation-gate.js";
import { RunAdmissionService } from "../run-admission-service.js";
import { SessionInteractionService } from "../session-interaction-service.js";
import { SessionPluginCapabilityService } from "../session-plugin-capability-service.js";
import { createSessionRuntimeDiscovery } from "../session-runtime-discovery.js";
import type { Settings } from "@vykor/host-config";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

function fixture(activePluginId?: string) {
  const dir = mkdtempSync(join(tmpdir(), "vk-plugin-continuity-"));
  const path = join(dir, "sessions.db");
  let store = new SessionStore({ path });
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.sessions.create({ id: "s1", cwd: dir, model: "test", metadata: { activePluginId, retained: true } });
  const owner = (pluginId: string): PluginCapabilityOwner => ({
    pluginId, displayName: pluginId, description: "", version: "1", scope: "user", origin: "native",
    skillNames: [], agentNames: [], mcpServerIds: [], nativeToolEntries: [],
  });
  const inventory: PluginCapabilityInventory = {
    plugins: new Map(["P", "Q"].map(id => [id, owner(id)])),
    skills: new Map(), agents: new Map(), nativeToolEntries: new Map(), mcpServers: new Map(), diagnostics: [],
  };
  let activeRunId: string | undefined;
  function application(resolveInventory = async () => inventory) {
    const admission = new RunAdmissionService({
      conversationTransactions: {
        admitPrompt: (input, config) => store.conversationTransactions.admitPrompt(input, config),
        admitPromptWithRun: (input, config) => store.conversationTransactions.admitPromptWithRun(input, config),
        replaceTranscriptAndAdmitPrompt: input => store.conversationTransactions.replaceTranscriptAndAdmitPrompt({ ...input, createRun: input.createRun ?? false }),
        replaceLatestPromptWithAdmission: input => store.conversationTransactions.replaceLatestPromptWithAdmission({ ...input, createRun: input.createRun ?? false }),
        getInput: id => store.conversations.getInput(id),
      },
      runOperations: store.runs,
      runtimeQueue: { hasRuntime: true, enqueueRun: () => "queued", steer: (_id, input) => {
        if (!activeRunId) return { merged: false };
        store.conversations.createMessage({ sessionId: "s1", role: "user", inputId: input.id, runId: activeRunId });
        return { merged: true, activeRunId, delivery: Promise.resolve({ runId: activeRunId }) };
      } },
      events: { checkpoint: () => 0, publishSince: () => {} },
    });
    return new SessionInteractionService({
      sessions: store.sessions, conversations: store.conversations, runs: store.runs, admission,
      pluginCapabilities: new SessionPluginCapabilityService({ resolveInventory }),
      operationRunner: { run: async (_id, work) => work() },
      control: { hasWork: () => !!activeRunId, activeRunId: () => activeRunId } as never,
      agentPool: { configured: true } as never,
      liveChildren: { has: () => false, send: async () => undefined, interrupt: async () => false },
      operationGate: new DaemonOperationGate(),
    });
  }
  return {
    get store() { return store; }, inventory, application,
    reopen() { store.close(); store = new SessionStore({ path }); return application(); },
    startRun(pluginId?: string) {
      const initial = store.conversationTransactions.admitPromptWithRun({
        prompt: { id: "active-input", sessionId: "s1", items: text(), metadata: pluginId ? { pluginId } : {} },
        run: { metadata: pluginId ? { pluginId } : {} },
      });
      activeRunId = initial.run.id;
      store.runs.updateRun(activeRunId, { status: "running" });
      return activeRunId;
    },
    finishRun() { store.runs.updateRun(activeRunId!, { status: "completed" }); activeRunId = undefined; },
  };
}

const text = (value = "continue"): SessionUserInputItem[] => [{ type: "text", text: value }];
const mention = (pluginId: string): SessionUserInputItem[] => [
  { type: "capability", kind: "plugin", pluginId, displayName: pluginId }, ...text(),
];

describe("session plugin continuity", () => {
  it("persists the first selection and gives a plain follow-up the same Input/Run plugin", async () => {
    const f = fixture(); const app = f.application();
    await app.admitPrompt("s1", { id: "first", items: mention("P") });
    expect(f.store.sessions.get("s1")?.metadata).toMatchObject({ activePluginId: "P", retained: true });
    const next = await app.admitPrompt("s1", { id: "next", items: text() });
    expect(next.input.metadata.pluginId).toBe("P");
    expect(next.run?.metadata.pluginId).toBe("P");
  });

  it("restores selection from SQLite after reopening the store", async () => {
    const f = fixture();
    await f.application().admitPrompt("s1", { id: "first", items: mention("P") });
    const next = await f.reopen().admitPrompt("s1", { id: "restored", items: text() });
    expect(next.run?.metadata.pluginId).toBe("P");
  });

  it("switches explicitly to another plugin without merging both plugins", async () => {
    const f = fixture("P"); const app = f.application();
    await app.admitPrompt("s1", { id: "switch", items: mention("Q") });
    expect(f.store.sessions.get("s1")?.metadata.activePluginId).toBe("Q");
    expect((await app.admitPrompt("s1", { id: "next", items: text() })).run?.metadata.pluginId).toBe("Q");
  });

  it("does not undo a later selection when an earlier input is retried", async () => {
    const f = fixture(); const app = f.application();
    await app.admitPrompt("s1", { id: "plain", items: text() });
    await app.admitPrompt("s1", { id: "P", items: mention("P") });
    await app.admitPrompt("s1", { id: "inherited", items: text() });
    await app.admitPrompt("s1", { id: "Q", items: mention("Q") });
    expect((await app.admitPrompt("s1", { id: "plain", items: text() })).run?.metadata.pluginId).toBeUndefined();
    expect((await app.admitPrompt("s1", { id: "P", items: mention("P") })).run?.metadata.pluginId).toBe("P");
    expect((await app.admitPrompt("s1", { id: "inherited", items: text() })).run?.metadata.pluginId).toBe("P");
    expect(f.store.sessions.get("s1")?.metadata.activePluginId).toBe("Q");
  });

  it("rolls back selection together with an admission whose run creation fails", async () => {
    const f = fixture("P");
    f.store.conversationTransactions.setTestHooks({ beforeRunCreation: () => { throw new Error("run failed"); } });
    await expect(f.application().admitPrompt("s1", { id: "rejected", items: mention("Q") })).rejects.toThrow("run failed");
    expect(f.store.sessions.get("s1")?.metadata.activePluginId).toBe("P");
    expect(f.store.conversations.getInput("rejected")).toBeUndefined();
  });

  it("allows ordinary chat when the retained plugin is disabled or uninstalled", async () => {
    const f = fixture("P"); f.inventory.plugins.delete("P");
    const result = await f.application().admitPrompt("s1", { id: "missing", items: text() });
    expect(result.run?.metadata.pluginId).toBeUndefined();
    await expect(f.application().admitPrompt("s1", { id: "explicit", items: mention("P") })).rejects.toThrow("session_plugin_capability_unavailable");
  });

  it("keeps a fresh session ordinary and ignores forged Input/Run plugin metadata", async () => {
    const f = fixture();
    const result = await f.application().admitPrompt("s1", {
      id: "plain", items: text(), metadata: { pluginId: "P" }, runMetadata: { pluginId: "P" },
    });
    expect(result.run?.metadata.pluginId).toBeUndefined();
    expect(f.store.sessions.get("s1")?.metadata.activePluginId).toBeUndefined();
  });

  it("honors a cleared session selection on subsequent inputs", async () => {
    const f = fixture("P");
    f.store.sessions.update("s1", { metadata: { activePluginId: null } });
    expect((await f.application().admitPrompt("s1", { id: "plain", items: text() })).run?.metadata.pluginId).toBeUndefined();
  });

  it("does not let a goal continuation overwrite a later explicit session selection", () => {
    const f = fixture("Q");
    f.store.conversationTransactions.admitPromptWithRun({
      prompt: { id: "goal-continuation", sessionId: "s1", items: text(), metadata: { pluginId: "P", goalRunKind: "continuation" } },
      run: { metadata: { pluginId: "P", goalRunKind: "continuation" } },
    });
    expect(f.store.sessions.get("s1")?.metadata.activePluginId).toBe("Q");
  });

  it("suspends inherited selection while the session plugin switch is off", async () => {
    const f = fixture("P");
    f.store.sessions.update("s1", { metadata: { activePluginId: "P", runtime: { model: "test", pluginsEnabled: false } } });
    const result = await f.application().admitPrompt("s1", { id: "disabled", items: text() });
    expect(result.run?.metadata.pluginId).toBeUndefined();
    expect(f.store.sessions.get("s1")?.metadata.activePluginId).toBe("P");
    await expect(f.application().admitPrompt("s1", { id: "explicit-disabled", items: mention("P") })).rejects.toThrow("session_plugin_capability_unavailable");
  });

  it("allows ordinary chat while global discovery is empty and resumes selection when enabled again", async () => {
    const f = fixture("P"); const available = [...f.inventory.plugins];
    f.inventory.plugins.clear();
    expect((await f.application().admitPrompt("s1", { id: "off", items: text() })).run?.metadata.pluginId).toBeUndefined();
    for (const [id, owner] of available) f.inventory.plugins.set(id, owner);
    expect((await f.application().admitPrompt("s1", { id: "on", items: text() })).run?.metadata.pluginId).toBe("P");
  });

  it("honors the actual global plugin setting in runtime discovery", async () => {
    const f = fixture("P");
    const discovery = createSessionRuntimeDiscovery({ settings: { plugins: { enabled: false } } as Settings });
    const app = f.application(async () => discovery.resolvePluginInventory(f.store.sessions.get("s1")!));
    expect((await app.admitPrompt("s1", { id: "global-off", items: text() })).run?.metadata.pluginId).toBeUndefined();
    await expect(app.admitPrompt("s1", { id: "global-explicit", items: mention("P") }))
      .rejects.toThrow("session_plugin_capability_unavailable");
  });

  it("merges a plain follow-up into the active run of the same plugin", async () => {
    const f = fixture("P"); const runId = f.startRun("P");
    const result = await f.application().admitPrompt("s1", { id: "steer", delivery: "steer", items: text() });
    expect(result.run?.id).toBe(runId);
    expect(result.input.metadata.pluginId).toBe("P");
    expect(f.store.runs.listRuns("s1")).toHaveLength(1);
  });

  it.each([undefined, "Q"])("rejects inherited plugin steering when the active run uses %s", async pluginId => {
    const f = fixture("P"); f.startRun(pluginId);
    await expect(f.application().admitPrompt("s1", { id: "mismatch", delivery: "steer", items: text() }))
      .rejects.toThrow("session_capability_requires_queued_run");
    expect(f.store.conversations.getInput("mismatch")).toBeUndefined();
  });

  it("returns the original successful steer on retry after its active run finished", async () => {
    const f = fixture("P"); const runId = f.startRun("P"); const app = f.application();
    const input = { id: "successful-steer", delivery: "steer" as const, items: text() };
    await app.admitPrompt("s1", input);
    f.finishRun();
    const retry = await app.admitPrompt("s1", input);
    expect(retry.run?.id).toBe(runId);
    expect(f.store.runs.listRuns("s1")).toHaveLength(1);
  });
});
