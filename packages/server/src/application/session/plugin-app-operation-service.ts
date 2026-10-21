import { createHash } from "node:crypto";
import type { VykorAgent } from "@vykor/agent-runtime";
import { nativeToolResultToAppResult, mcpToolResultToAppResult } from "@vykor/agent-runtime";
import type { ToolResult } from "@vykor/core";
import { parsePluginAppToolRequest, readPluginAppAction, stringifyCanonicalJson,
  type PluginAppActionMetadata, type PluginAppActionResponse, type PluginAppRecord, type PluginAppSource,
  type PluginAppToolRequest, type SessionRunRecord } from "@vykor/protocol";
import type { SessionStore } from "@vykor/services";
import type { SessionRunEngine } from "./session-run-engine.js";
import type { SessionOperationRunner } from "./session-operation-runner.js";
import type { SessionPluginAppService } from "./session-plugin-app-service.js";
import type { SessionRunWorkContext } from "../../runtime/run-coordinator.js";
import { ApplicationError } from "../../shared/application-error.js";
import { PluginAppAdmissionError } from "./plugin-app-admission-error.js";

/** Only this rejection proves a request was not admitted because another Run owns the session. */
class PluginAppBusyError extends ApplicationError {
  constructor() { super(409, "会话正在处理其他操作"); }
}

export function pluginAppRequestId(source: PluginAppSource, requestId: string, kind = "action"): string {
  return `app_${kind}_${createHash("sha256").update(JSON.stringify([source.sessionId, source.appId, requestId])).digest("hex")}`;
}
export function pluginAppFingerprint(app: PluginAppRecord, value: object): string {
  return createHash("sha256").update(stringifyCanonicalJson({ source: { sessionId: app.sessionId, appId: app.id },
    pluginId: app.pluginId, pluginVersion: app.pluginVersion, pluginDigest: app.pluginDigest, definitionDigest: app.definitionDigest,
    backendId: app.backendId, backendKind: app.backendKind, resourceUri: app.resourceUri, ...value })).digest("hex");
}
export function verifiedAppAction(run: SessionRunRecord, app: PluginAppRecord): PluginAppActionMetadata | undefined {
  const action = readPluginAppAction(run.metadata);
  if (!action || run.sessionId !== app.sessionId || action.source.sessionId !== app.sessionId || action.source.appId !== app.id
    || run.id !== pluginAppRequestId(action.source, action.requestId)
    || action.toolUseId !== `app_tool_${run.id}` || action.pluginId !== app.pluginId || action.pluginVersion !== app.pluginVersion
    || action.pluginDigest !== app.pluginDigest || action.definitionDigest !== app.definitionDigest
    || action.backendId !== app.backendId || action.backendKind !== app.backendKind || action.resourceUri !== app.resourceUri
    || action.requestFingerprint !== pluginAppFingerprint(app, { toolName: action.toolName, args: action.args, expectedRevision: action.expectedRevision })) return undefined;
  return action;
}
export interface PluginAppOperationOptions {
  store: SessionStore; apps: SessionPluginAppService; operations: SessionOperationRunner;
  engine: Pick<SessionRunEngine, "enqueueHostWork" | "runtimeBridge">;
  acquireSession(id: string): Promise<VykorAgent>;
  execute(runId: string, request: PluginAppToolRequest, context: SessionRunWorkContext): Promise<void>;
  interrupt(sessionId: string, runId: string): void;
  assertAvailable?(source: PluginAppSource): void;
}
/** Atomic admission and receipts; the original Run and Part are the only execution record. */
export class PluginAppOperationService {
  constructor(private readonly options: PluginAppOperationOptions) {}
  readSource(source: PluginAppSource): PluginAppRecord {
    if (!this.options.store.sessions.get(source.sessionId)) throw new ApplicationError(404, "会话不存在");
    const app = this.options.store.pluginApps.get(source.appId);
    if (!app || app.sessionId !== source.sessionId) throw new ApplicationError(404, "应用不存在");
    return app;
  }
  assertState(source: PluginAppSource, revision: number, ownerRunId?: string): PluginAppRecord {
    this.options.assertAvailable?.(source);
    const app = this.readSource(source), session = this.options.store.sessions.get(source.sessionId)!;
    const bridge = this.options.engine.runtimeBridge;
    if (session.status === "closing" || session.status === "archived" || app.status !== "open"
      || app.controlRevision !== revision || app.activeActionRunId !== ownerRunId)
      throw new ApplicationError(409, "应用状态或确认版本已变化");
    if ((bridge.hasWork(source.sessionId) && bridge.activeRunId(source.sessionId) !== ownerRunId)
      || (!ownerRunId && this.options.store.runs.listRuns(source.sessionId).some(run => run.status === "pending" || run.status === "running")))
      throw new PluginAppBusyError();
    return app;
  }
  async invoke(value: PluginAppToolRequest): Promise<PluginAppActionResponse> {
    const request = parsePluginAppToolRequest(value); // Copy before the first await.
    const app = this.readSource(request.source);
    const fingerprint = pluginAppFingerprint(app, { toolName: request.toolName, args: request.args, expectedRevision: request.expectedRevision });
    const runId = pluginAppRequestId(request.source, request.requestId);
    return this.options.operations.run(app.sessionId, async () => {
      this.readSource(request.source);
      const existing = this.options.store.runs.getRun(runId);
      if (existing) {
        if (verifiedAppAction(existing, app)?.requestFingerprint !== fingerprint) throw new ApplicationError(409, "请求 ID 已用于不同操作");
        return this.read(request.source, request.requestId);
      }
      try {
      await this.options.apps.assertCanInvoke(request.source, request.lease);
      const agent = await this.options.acquireSession(app.sessionId);
      const registeredToolName = await agent.pluginApps.assertTool(app, request);
      this.assertState(request.source, request.expectedRevision);
      this.options.store.transaction(() => {
        this.assertState(request.source, request.expectedRevision);
        this.options.store.runs.createRun({ id: runId, sessionId: app.sessionId });
        const accepted = this.options.store.pluginApps.admitAction(app.id, { expectedRevision: request.expectedRevision, runId });
        const action: PluginAppActionMetadata = { schemaVersion: 1, source: request.source, requestId: request.requestId,
          requestFingerprint: fingerprint, expectedRevision: request.expectedRevision, acceptedRevision: accepted.controlRevision,
          pluginId: app.pluginId, pluginVersion: app.pluginVersion, pluginDigest: app.pluginDigest, definitionDigest: app.definitionDigest,
          backendId: app.backendId, backendKind: app.backendKind, resourceUri: app.resourceUri,
          toolName: request.toolName, registeredToolName, toolUseId: `app_tool_${runId}`, args: request.args, executionState: "not_started" };
        this.options.store.runs.updateRun(runId, { metadata: { pluginAppAction: action } });
      });
      } catch (error) {
        // Still inside the same session admission lock. Never label an existing Run unaccepted.
        if (error instanceof ApplicationError && !this.options.store.runs.getRun(runId)) throw new PluginAppAdmissionError({
          code: "plugin_app_not_accepted", kind: "tool", source: request.source,
          requestId: request.requestId, expectedRevision: request.expectedRevision,
          ...(error instanceof PluginAppBusyError ? { reason: "busy" as const } : {}),
        });
        throw error;
      }
      try { this.options.engine.enqueueHostWork({ sessionId: app.sessionId, runId, work: context => this.options.execute(runId, request, context) }); }
      catch { this.settle(runId, "failed", undefined, "plugin_app_enqueue_failed"); }
      return this.read(request.source, request.requestId);
    });
  }
  async prepare(runId: string, request: PluginAppToolRequest) {
    const app = this.readSource(request.source), run = this.options.store.runs.getRun(runId);
    const action = run && verifiedAppAction(run, app);
    if (!run || !action || action.requestFingerprint !== pluginAppFingerprint(app, {
      toolName: request.toolName, args: request.args, expectedRevision: request.expectedRevision }))
      throw new ApplicationError(409, "操作来源无法验证");
    await this.options.apps.assertCanInvoke(request.source, request.lease);
    const agent = await this.options.acquireSession(app.sessionId);
    if (await agent.pluginApps.assertTool(app, request) !== action.registeredToolName) throw new ApplicationError(409, "工具绑定已变化");
    const current = this.assertState(request.source, action.acceptedRevision, runId);
    return { app: current, run, action, agent };
  }
  read(source: PluginAppSource, requestId: string): PluginAppActionResponse {
    const app = this.readSource(source), run = this.options.store.runs.getRun(pluginAppRequestId(source, requestId));
    const action = run && verifiedAppAction(run, app);
    if (!run || !action) throw new ApplicationError(404, "操作回执不存在");
    const response: PluginAppActionResponse = { receipt: { source, requestId, runId: run.id, status: run.status,
      expectedRevision: action.expectedRevision, acceptedRevision: action.acceptedRevision, executionState: action.executionState } };
    // Only committed terminal facts permit page conversion. Never store or broadcast a second private result.
    if (action.executionState === "completed" && !["pending", "running"].includes(run.status)) {
      const part = this.options.store.conversations.listMessageParts(app.sessionId).find(p => p.id === action.toolUseId);
      if (part?.output) {
        try { Object.assign(response, (app.backendKind === "native-tools" ? nativeToolResultToAppResult : mcpToolResultToAppResult)(part.output as ToolResult)); }
        catch { response.dataError = "plugin_app_result_unavailable"; }
      } else response.dataError = "plugin_app_result_unavailable";
    }
    return response;
  }
  cancel(source: PluginAppSource, requestId: string): PluginAppActionResponse {
    const receipt = this.read(source, requestId).receipt;
    this.options.interrupt(source.sessionId, receipt.runId);
    if (this.options.engine.runtimeBridge.activeRunId(source.sessionId) !== receipt.runId)
      this.settle(receipt.runId, "interrupted", undefined, "plugin_app_cancelled_before_start");
    return this.read(source, requestId);
  }
  settle(runId: string, status: "completed" | "failed" | "interrupted", result?: ToolResult, error?: string): void {
    const { store } = this.options;
    store.transaction(() => {
      const run = store.runs.getRun(runId), raw = run && readPluginAppAction(run.metadata);
      const app = raw && store.pluginApps.get(raw.source.appId), action = run && app && verifiedAppAction(run, app);
      if (!run || !app || !action || app.activeActionRunId !== runId) return;
      const executionState = result?.executionState ?? action.executionState;
      const part = store.conversations.listMessageParts(run.sessionId).find(p => p.id === action.toolUseId);
      if (part) store.conversations.upsertMessagePart({ ...part, status, ...(result ? { output: result, isError: result.isError === true } : {}),
        metadata: { ...part.metadata, executionState, toolProgress: null } });
      store.runs.updateRun(runId, { status, ...(error ? { error } : {}), metadata: { pluginAppAction: { ...action, executionState } } });
      store.pluginApps.settleAction(app.id, runId);
    });
  }
  /** Restart never queues app actions; preserve unknown while releasing the stale active pointer. */
  recover(): void {
    for (const app of this.options.store.pluginApps.list()) {
      if (!app.activeActionRunId) continue;
      const run = this.options.store.runs.getRun(app.activeActionRunId);
      if (run && verifiedAppAction(run, app)) this.settle(run.id, "interrupted", undefined, "plugin_app_runtime_restarted");
      // Missing/corrupt facts remain a blocking pointer rather than being erased.
    }
  }
}
