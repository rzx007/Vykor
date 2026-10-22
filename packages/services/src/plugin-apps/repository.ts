import { randomUUID } from "node:crypto";
import type { PluginAppRecord } from "@vykor/domain-contracts/plugin-apps";
import type { StorageContext } from "../database/storage-context.js";
import { assertMutableSession, assertSession, clone } from "../session-runtime/store-state.js";

export type CreatePluginAppInput = Omit<PluginAppRecord, "id" | "status" | "controlRevision" | "activeActionRunId" | "lastActionRunId" | "createdAt" | "updatedAt"> & { id?: string };

/** The existing SessionStore cache/transaction is the only authority for app control state. */
export class PluginAppRepository {
  constructor(private readonly storage: StorageContext, private readonly changed?: (app: PluginAppRecord) => void) {}

  get(id: string): PluginAppRecord | undefined { const app = this.storage.state.pluginApps[id]; return app ? clone(app) : undefined; }
  findByLogicalKey(sessionId: string, logicalKey: string): PluginAppRecord | undefined {
    return this.list(sessionId).find(app => app.logicalKey === logicalKey);
  }
  list(sessionId?: string): PluginAppRecord[] {
    return clone(Object.values(this.storage.state.pluginApps).filter(app => !sessionId || app.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
  }
  create(input: CreatePluginAppInput): PluginAppRecord {
    return this.storage.atomic(() => {
      this.storage.assertWritable(); assertMutableSession(assertSession(this.storage.state, input.sessionId));
      const existing = this.findByLogicalKey(input.sessionId, input.logicalKey);
      if (existing) {
        if (["pluginId", "pluginVersion", "pluginDigest", "definitionDigest", "backendId", "backendKind", "resourceUri"].some(key => existing[key as keyof PluginAppRecord] !== input[key as keyof CreatePluginAppInput])
          || !sameOrigin(existing.origin, input.origin)) throw new Error("plugin_app_logical_key_conflict");
        return existing;
      }
      const id = input.id ?? randomUUID();
      if (this.storage.state.pluginApps[id]) throw new Error("plugin_app_id_conflict");
      const timestamp = Date.now();
      const app: PluginAppRecord = { ...clone(input), id, status: "open", controlRevision: 0, createdAt: timestamp, updatedAt: timestamp };
      this.storage.rollback?.capture(this.storage.state.pluginApps, id);
      this.storage.state.pluginApps[id] = app; this.storage.mutations.pluginApps.add(id);
      this.changed?.(clone(app)); return clone(app);
    });
  }
  close(id: string, expectedRevision?: number): PluginAppRecord { return this.transition(id, "closed", expectedRevision); }
  revoke(id: string): PluginAppRecord { return this.transition(id, "revoked"); }
  /** Host must freshly verify installation/approval before reopening. Last operation facts stay intact. */
  reopen(id: string): PluginAppRecord { return this.transition(id, "open"); }

  private transition(id: string, status: PluginAppRecord["status"], expectedRevision?: number): PluginAppRecord {
    return this.storage.atomic(() => {
      const app = this.require(id);
      if (app.status === status || (app.status === "revoked" && status === "closed")) return clone(app);
      if (app.status === "revoked") throw new Error("plugin_app_revoked");
      if (expectedRevision !== undefined && expectedRevision !== app.controlRevision) throw new Error("plugin_app_revision_conflict");
      if (status === "open") assertMutableSession(assertSession(this.storage.state, app.sessionId));
      this.change(app); app.status = status;
      this.changed?.(clone(app)); return clone(app);
    });
  }
  /** Wrap this and Run creation in store.transaction. No tool invocation occurs here. */
  admitAction(id: string, input: { expectedRevision: number; runId: string }): PluginAppRecord {
    return this.storage.atomic(() => {
      const app = this.require(id);
      if (app.activeActionRunId === input.runId) return clone(app);
      assertMutableSession(assertSession(this.storage.state, app.sessionId));
      if (app.status !== "open") throw new Error("plugin_app_closed");
      if (app.controlRevision !== input.expectedRevision) throw new Error("plugin_app_revision_conflict");
      if (app.activeActionRunId) throw new Error("plugin_app_busy");
      const run = this.storage.state.runs[input.runId];
      if (!run || run.sessionId !== app.sessionId) throw new Error("plugin_app_run_missing");
      // Unknown/missing execution facts are checked by the trusted admission service before this transaction.
      this.change(app); app.activeActionRunId = input.runId;
      this.changed?.(clone(app)); return clone(app);
    });
  }
  /** Commit original Run result/facts in the same outer transaction before calling this. */
  settleAction(id: string, runId: string): PluginAppRecord {
    return this.storage.atomic(() => {
      const app = this.require(id);
      if (app.activeActionRunId !== runId) return clone(app);
      this.change(app); delete app.activeActionRunId; app.lastActionRunId = runId;
      this.changed?.(clone(app)); return clone(app);
    });
  }
  private require(id: string): PluginAppRecord {
    this.storage.assertWritable(); const app = this.storage.state.pluginApps[id];
    if (!app) throw new Error("plugin_app_not_found"); return app;
  }
  private change(app: PluginAppRecord): void {
    if (!Number.isSafeInteger(app.controlRevision + 1)) throw new Error("plugin_app_revision_overflow");
    this.storage.rollback?.capture(this.storage.state.pluginApps, app.id);
    app.controlRevision++; app.updatedAt = Date.now(); this.storage.mutations.pluginApps.add(app.id);
  }
}

function sameOrigin(left: PluginAppRecord["origin"], right: PluginAppRecord["origin"]): boolean {
  return left.kind === right.kind && (left.kind === "surface" ? right.kind === "surface" && left.surfaceId === right.surfaceId : right.kind === "tool-result" && left.sourcePartId === right.sourcePartId);
}
