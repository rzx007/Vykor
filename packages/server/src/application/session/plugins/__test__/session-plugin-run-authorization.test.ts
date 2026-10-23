import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createRunCapabilityView } from "@vykor/agent-runtime";
import { ToolRegistry } from "@vykor/core";
import { SessionStore } from "@vykor/services";
import { SessionPluginCapabilityService } from "../session-plugin-capability-service.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

it("captures a worker's authorized plugin scope without a UI service or UI components", () => {
  const directory = mkdtempSync(join(tmpdir(), "vykor-run-plugin-authorization-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SessionStore({ path: join(directory, "session.db") });
  cleanup.push(() => store.close());
  const parent = store.sessions.create({ id: "parent", cwd: directory, model: "script-only" });
  const parentInput = store.conversationTransactions.admitPrompt({ sessionId: parent.id, content: "delegate" });
  const candidate = { pluginId: "example.worker", displayName: "Worker", description: "Work", version: "1.0.0", behaviorDigest: "a".repeat(64) };
  store.runs.createRun({ id: "parent-run", sessionId: parent.id, inputId: parentInput.id, metadata: { pluginId: null,
    pluginSelection: { status: "resolved", scopeVersion: 2, source: "auto", pluginId: null, reason: "matched",
      pluginIds: [candidate.pluginId], candidates: [candidate] } } });
  const child = store.sessions.create({ id: "worker", parentId: parent.id, cwd: directory, model: "script-only", metadata: { childId: "worker-handle" } });
  const input = store.conversationTransactions.admitPrompt({ sessionId: child.id, content: "work" });
  store.runs.createRun({ id: "worker-run", sessionId: child.id, inputId: input.id, metadata: { parentRunId: "parent-run" } });
  store.runs.updateRun("worker-run", { status: "running" });
  const capabilityView = createRunCapabilityView({ toolRegistry: new ToolRegistry(), pluginIds: new Set([candidate.pluginId]) }, [candidate.pluginId]);
  const service = new SessionPluginCapabilityService({ store, resolveInventory: async () => {
    throw new Error("Captured Run authorization must not rediscover or expand the inventory");
  } });
  service.authorizeRun({ scope: { agentId: child.id, sessionId: child.id, inputId: input.id,
    runId: "worker-run", traceId: "trace", cwd: directory, signal: new AbortController().signal },
    identity: { childId: "worker-handle", parentSessionId: parent.id, parentRunId: "parent-run" }, capabilityView, pluginCandidates: [candidate] });
  expect(store.runs.getRun("worker-run")?.metadata).toMatchObject({ parentRunId: "parent-run", pluginId: null,
    pluginSelection: { scopeVersion: 2, pluginIds: [candidate.pluginId], candidates: [candidate] } });
});
