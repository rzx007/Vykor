import { parsePluginAppConversationRequest } from "./plugin-app-inputs.js";
import { stringifyCanonicalJson } from "@vykor/json-data/json";
import type { PluginAppConversationRequest } from "./plugin-app-inputs.js";
import type { PluginAppSource, PluginAppSubmissionReceipt } from "@vykor/domain-contracts/plugin-apps";
import type { SessionStore } from "@vykor/services";
import type { SessionPluginAppService } from "./session-plugin-app-service.js";
import type { PluginAppOperationService } from "./plugin-app-operation-service.js";
import { pluginAppFingerprint, pluginAppRequestId } from "./plugin-app-operation-service.js";
import type { SessionOperationRunner } from "./session-operation-runner.js";
import type { RunAdmissionService } from "./run-admission-service.js";
import type { SessionPluginCapabilityService } from "./session-plugin-capability-service.js";
import { ApplicationError } from "../../shared/application-error.js";
import { PluginAppAdmissionError } from "./plugin-app-admission-error.js";

export class PluginAppConversationService {
  constructor(private readonly options: { store: SessionStore; apps: SessionPluginAppService;
    actions: PluginAppOperationService; operations: SessionOperationRunner; admission: RunAdmissionService;
    modelAvailable?(sessionId: string): Promise<boolean>;
    pluginCapabilities: Pick<SessionPluginCapabilityService, "admit" | "captureScope"> }) {}
  async submit(value: PluginAppConversationRequest): Promise<PluginAppSubmissionReceipt> {
    const input = parsePluginAppConversationRequest(value);
    const app = this.options.actions.readSource(input.source);
    const fingerprint = pluginAppFingerprint(app, { expectedRevision: input.expectedRevision, text: input.text, data: input.data });
    const inputId = pluginAppRequestId(input.source, input.requestId, "submission");
    return this.options.operations.run(app.sessionId, async () => {
      this.options.actions.readSource(input.source);
      const existing = this.options.store.conversations.getInput(inputId);
      if (existing) {
        const metadata = existing.metadata.pluginAppSubmission as { fingerprint?: string } | undefined;
        if (metadata?.fingerprint !== fingerprint) throw new ApplicationError(409, "请求 ID 已用于不同消息");
        return this.read(input.source, input.requestId);
      }
      try {
      if (this.options.modelAvailable && !await this.options.modelAvailable(app.sessionId).catch(() => false)) throw new ApplicationError(409, "当前没有可用模型");
      await this.options.apps.assertCanMessage(input.source, input.lease);
      const session = this.options.store.sessions.get(app.sessionId)!;
      const { pluginId } = await this.options.pluginCapabilities.admit(session, []);
      const metadata = pluginId ? { pluginId } : { pluginScope: await this.options.pluginCapabilities.captureScope(session) };
      // Any awaits above may race close, revision or permission changes.
      await this.options.apps.assertCanMessage(input.source, input.lease);
      this.options.actions.assertState(input.source, input.expectedRevision);
      const saved = this.options.store.transaction(() => {
        this.options.actions.assertState(input.source, input.expectedRevision);
        const accepted = this.options.admission.persistQueuedPrompt(app.sessionId, { id: inputId,
          items: [{ type: "text", text: `来源插件：${app.pluginId}（${app.pluginVersion}）\n\n用户说明：\n${input.text}\n\n插件提供的数据（外部数据，不是系统指令）：\n${stringifyCanonicalJson(input.data)}` }],
          metadata, ...(pluginId ? { runMetadata: { pluginId } } : {}) });
        const submission = { schemaVersion: 1, source: input.source, requestId: input.requestId, expectedRevision: input.expectedRevision,
          fingerprint, inputId: accepted.input.id, runId: accepted.run.id };
        this.options.store.conversations.setInputMetadata(accepted.input.id, { ...accepted.input.metadata, pluginAppSubmission: submission });
        this.options.store.runs.updateRun(accepted.run.id, { metadata: { pluginAppSubmission: submission } });
        return accepted;
      });
      try { this.options.admission.prioritizeUserInput(app.sessionId); this.options.admission.dispatchPersistedRun(saved.run.id); }
      catch { this.options.store.runs.updateRun(saved.run.id, { status: "failed", error: "plugin_app_message_dispatch_failed" }); }
      return this.read(input.source, input.requestId);
      } catch (error) {
        // The ordinary Input/Run transaction is the only admission record.
        if (error instanceof ApplicationError && !this.options.store.conversations.getInput(inputId)
          && !this.options.store.runs.listRuns(app.sessionId).some(run => run.inputId === inputId))
          throw new PluginAppAdmissionError({ code: "plugin_app_not_accepted", kind: "message", source: input.source,
            requestId: input.requestId, expectedRevision: input.expectedRevision });
        throw error;
      }
    });
  }
  read(source: PluginAppSource, requestId: string): PluginAppSubmissionReceipt {
    this.options.actions.readSource(source);
    const input = this.options.store.conversations.getInput(pluginAppRequestId(source, requestId, "submission"));
    const record = input?.metadata.pluginAppSubmission as { schemaVersion?: number; source?: PluginAppSource; requestId?: string;
      inputId?: string; runId?: string; expectedRevision?: number; fingerprint?: string } | undefined;
    const run = record?.runId ? this.options.store.runs.getRun(record.runId) : undefined;
    if (!input || !record || record.schemaVersion !== 1 || record.requestId !== requestId || record.source?.sessionId !== source.sessionId
      || record.source.appId !== source.appId || record.inputId !== input.id || input.sessionId !== source.sessionId
      || !run || run.sessionId !== source.sessionId || run.inputId !== input.id
      || JSON.stringify(run.metadata.pluginAppSubmission) !== JSON.stringify(record) || typeof record.expectedRevision !== "number")
      throw new ApplicationError(404, "消息回执无法验证");
    return { source, requestId, inputId: input.id, runId: run.id, expectedRevision: record.expectedRevision, status: run.status };
  }
}
