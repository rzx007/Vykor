import type {
  AgentRunCapabilitySnapshot,
  PluginCapabilityInventory,
} from "@vykor/agent-runtime";
import { resolve } from "node:path";
import type { SessionStore } from "@vykor/services";
import type { SessionRecord } from "@vykor/domain-contracts/sessions";
import type { SessionUserInputItem } from "@vykor/domain-contracts/inputs";
import { readRuntimeMetadata } from "@vykor/domain-contracts/sessions";
import { SessionApplicationError } from "./session-application-error.js";
import {
  capturePluginSelectionPolicy, emptyPluginScope, readInputPluginScope, readRunPluginScope,
  runPluginSourceMatches, type InputPluginScope,
} from "./session-plugin-selection.js";

export interface SessionPluginCapabilityServiceContext {
  resolveInventory(session: SessionRecord): Promise<PluginCapabilityInventory>;
  /** Required only by the execution host that captures an actual prepared Run. */
  store?: Pick<SessionStore, "sessions" | "runs" | "conversations" | "transaction">;
}

export class SessionPluginCapabilityService {
  constructor(private readonly context: SessionPluginCapabilityServiceContext) {}

  /** Called by the host after reliable run.started projection and before any model or tool. */
  authorizeRun(snapshot: AgentRunCapabilitySnapshot): void {
    const store = this.context.store;
    if (!store) throw new Error("Run plugin authorization store is unavailable");
    const { scope, identity, capabilityView: view, pluginCandidates } = snapshot;
    const session = store.sessions.get(scope.sessionId);
    const run = store.runs.getRun(scope.runId);
    const input = store.conversations.getInput(scope.inputId);
    const owners = [...(view.pluginIds ?? new Set(view.pluginId ? [view.pluginId] : []))];
    const candidates = owners.map(id => pluginCandidates.find(candidate => candidate.pluginId === id));
    const invalid = () => new Error("Run plugin capability identity mismatch");
    // SessionStore resolves host paths; a child environment may retain an equivalent relative lease.
    if (!session || !run || !input || scope.agentId !== session.id || resolve(scope.cwd) !== session.cwd ||
      run.sessionId !== session.id || input.sessionId !== session.id || run.inputId !== input.id || run.status !== "running" ||
      pluginCandidates.length !== owners.length || candidates.some(candidate => !candidate) ||
      new Set(pluginCandidates.map(candidate => candidate.pluginId)).size !== owners.length ||
      (view.pluginId !== undefined && (owners.length !== 1 || owners[0] !== view.pluginId))) throw invalid();
    const captured = readInputPluginScope({ scopeVersion: 2, source: owners.length ? "auto" : "none", pluginIds: owners,
      candidates: candidates.map(candidate => ({ ...candidate! })) })!;
    const matches = (source: NonNullable<ReturnType<typeof store.runs.getRun>>) => captured.candidates.every(candidate =>
      runPluginSourceMatches(source, { pluginId: candidate.pluginId, pluginVersion: candidate.version, pluginDigest: candidate.behaviorDigest }));
    store.transaction(() => {
      if (identity?.childId) {
        if (session.metadata.childId !== identity.childId) throw invalid();
        if (identity.parentRunId === undefined && identity.parentSessionId === undefined) {
          // A host child.send has no current parent Run: its durable task proves baseline ownership only.
          const task = store.runs.getSessionTask(identity.childId);
          if (owners.length || run.metadata.parentRunId !== undefined || !task || task.type !== "agent" ||
            task.childSessionId !== session.id || task.sessionId !== session.parentId || task.runId !== run.id ||
            task.status !== "running" || task.cwd !== session.cwd || task.metadata.origin !== "child_session" ||
            task.metadata.executionBackend !== "child_agent" || task.metadata.runtimeExecutionId !== identity.childId) throw invalid();
        } else {
          const parent = identity.parentRunId && store.runs.getRun(identity.parentRunId);
          if (!parent || parent.sessionId !== identity.parentSessionId || session.parentId !== parent.sessionId ||
            run.metadata.parentRunId !== parent.id || !matches(parent)) throw invalid();
        }
        if (run.metadata.pluginSelection !== undefined) {
          const saved = readRunPluginScope(run);
          if (!saved || saved.pluginIds.length !== owners.length || saved.pluginIds.some(id => !owners.includes(id)) || !matches(run)) throw invalid();
        }
        store.runs.updateRun(run.id, { metadata: { pluginId: view.pluginId ?? null,
          pluginSelection: { ...captured, status: "resolved", source: view.pluginId ? "inherited" : captured.source,
            pluginId: view.pluginId ?? null, reason: owners.length ? "matched" : "no_candidates" } } });
      } else {
        if (identity?.parentRunId || identity?.parentSessionId) throw invalid();
        const saved = readRunPluginScope(run);
        const savedIds = saved?.pluginIds ?? (typeof run.metadata.pluginId === "string" ? [run.metadata.pluginId] : []);
        if (savedIds.length !== owners.length || savedIds.some(id => !owners.includes(id)) || !matches(run)) throw invalid();
      }
    });
  }

  /** Freeze automatic eligibility before persistence, using the approved inventory. */
  async captureScope(session: SessionRecord): Promise<InputPluginScope> {
    if (capturePluginSelectionPolicy(session) === "none") return emptyPluginScope();
    const inventory = await this.context.resolveInventory(session);
    const candidates = [...inventory.plugins.values()].map(({ pluginId, displayName, description, version, behaviorDigest }) => ({
      pluginId, displayName, description, version, ...(behaviorDigest ? { behaviorDigest } : {}),
    }));
    return { scopeVersion: 2, source: "auto", pluginIds: candidates.map(candidate => candidate.pluginId), candidates };
  }

  async admit(
    session: SessionRecord,
    items: readonly SessionUserInputItem[],
  ): Promise<{ pluginId?: string }> {
    const activePluginId = typeof session.metadata?.activePluginId === "string"
      ? session.metadata.activePluginId : undefined;
    const pluginsEnabled = readRuntimeMetadata(session.metadata ?? {}).pluginsEnabled !== false;
    const hasReferences = items.some((item) =>
      item.type === "capability" || item.type === "skill"
    );
    if (!hasReferences && (!activePluginId || !pluginsEnabled)) return {};

    const inventory = await this.context.resolveInventory(session);
    const pluginIds = new Set<string>();
    for (const item of items) {
      if (item.type === "skill") {
        const owner = inventory.skills.get(item.name);
        if (!owner || owner.path !== item.path) {
          if (item.source !== "plugin") continue;
          throw new SessionApplicationError(409, "session_plugin_capability_unavailable");
        }
        if (!inventory.plugins.has(owner.pluginId)) {
          throw new SessionApplicationError(409, "session_plugin_capability_unavailable");
        }
        pluginIds.add(owner.pluginId);
        continue;
      }
      if (item.type !== "capability") continue;

      if (!inventory.plugins.has(item.pluginId)) {
        throw new SessionApplicationError(409, "session_plugin_capability_unavailable");
      }
      if (
        item.kind === "plugin_agent" &&
        inventory.agents.get(item.agentId)?.pluginId !== item.pluginId
      ) {
        throw new SessionApplicationError(409, "session_plugin_capability_unavailable");
      }
      pluginIds.add(item.pluginId);
    }

    if (pluginIds.size > 1) {
      throw new SessionApplicationError(409, "session_plugin_capability_conflict");
    }
    // An explicit reference switches the selection; an ordinary turn keeps it.
    const explicitPluginId = [...pluginIds][0];
    if (explicitPluginId && !pluginsEnabled) {
      throw new SessionApplicationError(409, "session_plugin_capability_unavailable");
    }
    // A disabled, removed, or globally suspended plugin must not block ordinary
    // chat. Retain the identity so enabling it again can restore the selection.
    const pluginId = explicitPluginId ?? (pluginsEnabled && activePluginId && inventory.plugins.has(activePluginId)
      ? activePluginId : undefined);
    return pluginId ? { pluginId } : {};
  }
}
