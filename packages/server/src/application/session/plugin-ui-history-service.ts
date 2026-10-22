import { createHash } from "node:crypto";
import { isCommittedModelPart } from "@vykor/domain-contracts/sessions";
import { isJsonObject as isPluginUiRecord } from "@vykor/json-data/json";
import { readPluginUiAction, readPluginUiInstance, parsePluginUiSubmissionRecord, parsePluginUiConversationReceipt } from "@vykor/domain-contracts/plugin-apps/history";
import type { PluginUiActionReceipt, PluginUiActionResponse, PluginUiInstanceRecord, PluginUiSubmissionRecord, PluginUiConversationReceipt } from "@vykor/domain-contracts/plugin-apps/history";
import type { SessionMessagePartRecord, SessionRunRecord, SessionRecord } from "@vykor/domain-contracts/sessions";
import type { SessionStore } from "@vykor/services";
import { ApplicationError } from "../../shared/application-error.js";

/** Reads original receipts only. No loader, runtime, leases or execution dependencies. */
export class PluginUiHistoryService {
  constructor(private readonly options: { store: Pick<SessionStore, "sessions" | "runs" | "conversations"> }) {}
  readAction(
    sessionId: string,
    instanceId: string,
    requestId: string,
  ): PluginUiActionResponse {
    const receipt = this.getAction(sessionId, instanceId, requestId);
    const run = this.options.store.runs.getRun(receipt.runId)!;
    const action = readPluginUiAction(run.metadata)!;
    const part = this.options.store.conversations
      .listMessageParts(sessionId)
      .find((p) => p.id === action.toolUseId);
    return {
      receipt,
      ...(part?.output === undefined
        ? {}
        : { result: structuredClone(part.output) }),
    };
  }

  getAction(
    sessionId: string,
    instanceId: string,
    requestId: string,
  ): PluginUiActionReceipt {
    this.requireSource(sessionId, instanceId);
    const run = this.options.store.runs.getRun(
      actionRunId(sessionId, instanceId, requestId),
    );
    if (
      !run ||
      run.sessionId !== sessionId ||
      readPluginUiAction(run.metadata)?.instanceId !== instanceId
    ) {
      throw new ApplicationError(404, "找不到此操作", "plugin_ui_not_found");
    }
    return this.receipt(run);
  }

  private receipt(run: SessionRunRecord): PluginUiActionReceipt {
    const action = readPluginUiAction(run.metadata)!;
    const instance = this.requireSource(
      run.sessionId,
      action.instanceId,
    ).instance;
    return {
      requestId: action.requestId,
      runId: run.id,
      instanceId: action.instanceId,
      revision: instance.revision,
      status: run.status,
    };
  }

  private requireSource(sessionId: string, instanceId: string) {
    const session = this.options.store.sessions.get(sessionId);
    const part =
      session &&
      this.options.store.conversations
        .listMessageParts(sessionId)
        .find(
          (p) => readPluginUiInstance(p.metadata)?.instanceId === instanceId,
        );
    const instance = part && readPluginUiInstance(part.metadata);
    if (!session || !part || !instance || !this.validSource(part, instance)) {
      throw new ApplicationError(
        404,
        "找不到此会话中的插件界面",
        "plugin_ui_not_found",
      );
    }
    return { session, part, instance };
  }

  private validSource(
    part: SessionMessagePartRecord,
    instance: Pick<
      PluginUiInstanceRecord,
      | "sessionId"
      | "sourceRunId"
      | "sourcePartId"
      | "sourceToolUseId"
      | "sourceToolName"
      | "pluginId"
      | "pluginVersion"
      | "pluginDigest"
    >,
  ): boolean {
    const run = this.options.store.runs.getRun(instance.sourceRunId);
    const message = this.options.store.conversations
      .listMessages(instance.sessionId)
      .find((m) => m.id === part.messageId);
    return (
      part.sessionId === instance.sessionId &&
      part.id === instance.sourcePartId &&
      part.type === "tool" &&
      part.status === "completed" &&
      part.isError !== true &&
      part.metadata.executionState === "completed" &&
      isCommittedModelPart(part) &&
      isPluginUiRecord(part.output) &&
      part.output.executionState === "completed" &&
      part.output.isError !== true &&
      part.toolUseId === instance.sourceToolUseId &&
      part.toolName === instance.sourceToolName &&
      run?.sessionId === instance.sessionId &&
      runPluginSourceMatches(run, instance) &&
      !Object.hasOwn(run.metadata, "uiAction") &&
      message?.sessionId === instance.sessionId &&
      message.role === "assistant" &&
      message.runId === run.id
    );
  }

  getSubmission(
    sessionId: string,
    instanceId: string,
    requestId: string,
  ): Extract<PluginUiConversationReceipt, { mode: "submit" }> {
    const accepted = this.readAccepted(sessionId, instanceId);
    if (!accepted || accepted.record.requestId !== requestId)
      throw new ApplicationError(
        404,
        "找不到此交接回执",
        "plugin_ui_not_found",
      );
    return accepted.receipt;
  }

  private readAccepted(sessionId: string, instanceId: string) {
    const { part, instance } = this.requireSource(
      sessionId,
      instanceId,
    );
    if (!Object.hasOwn(part.metadata, "pluginUiSubmission")) return undefined;
    const corrupt = () =>
      new ApplicationError(
        409,
        "交接回执与实际记录不符",
        "plugin_ui_conversation_unavailable",
      );
    let record: PluginUiSubmissionRecord;
    try {
      record = parsePluginUiSubmissionRecord(part.metadata.pluginUiSubmission);
    } catch {
      throw corrupt();
    }
    const input = this.options.store.conversations.getInput(record.inputId);
    const run = this.options.store.runs.getRun(record.runId);
    const targetId = record.targetSessionId ?? sessionId;
    if (
      record.pluginDigest !== instance.pluginDigest ||
      record.componentDigest !== instance.componentDigest ||
      instance.status !== "resolved" ||
      instance.revision < record.expectedRevision + 1 ||
      !input ||
      !run ||
      (record.targetSessionId !== undefined && this.conversationTarget(sessionId, false).id !== targetId) ||
      input.sessionId !== targetId ||
      run.sessionId !== targetId ||
      run.inputId !== input.id ||
      input.delivery !== "queue" ||
      input.items.length !== 1 ||
      input.items[0]?.type !== "text" ||
      !input.items[0].text.trim() ||
      input.attachments.length ||
      Object.hasOwn(run.metadata, "uiAction") ||
      Object.hasOwn(input.metadata, "pluginUiSubmission") ||
      Object.hasOwn(run.metadata, "pluginUiSubmission")
    )
      throw corrupt();
    const receipt = parsePluginUiConversationReceipt({
      kind: "conversation",
      mode: "submit",
      instanceId,
      revision: record.expectedRevision + 1,
      requestId: record.requestId,
      inputId: record.inputId,
      runId: record.runId,
      status: run.status,
      ...(record.targetSessionId ? { targetSessionId: record.targetSessionId } : {}),
    });
    if (receipt.mode !== "submit") throw corrupt();
    return { record, receipt };
  }

  /** Only durable worker tasks authorize upward handoff; ordinary forks own their input. */
  private conversationTarget(sourceSessionId: string, mutable = true): SessionRecord {
    const seen = new Set<string>();
    let id = sourceSessionId;
    while (!seen.has(id)) {
      seen.add(id);
      const session = this.options.store.sessions.get(id);
      if (!session) break;
      const childId = session.metadata.childId;
      const task = typeof childId === "string" ? this.options.store.runs.getSessionTask(childId) : undefined;
      if (session.parentId && task?.type === "agent" && task.childSessionId === session.id && task.sessionId === session.parentId) {
        id = session.parentId;
        continue;
      }
      if (mutable && (session.status === "archived" || session.status === "closing")) break;
      return session;
    }
    throw new ApplicationError(409, "交接目标会话不可用", "plugin_ui_conversation_unavailable");
  }

}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function actionRunId(
  sessionId: string,
  instanceId: string,
  requestId: string,
): string {
  return `ui_run_${hash(JSON.stringify([sessionId, instanceId, requestId]))}`;
}

function runPluginSourceMatches(run: SessionRunRecord, source: Pick<PluginUiInstanceRecord, "pluginId" | "pluginVersion" | "pluginDigest">): boolean {
  const selection = run.metadata.pluginSelection as { scopeVersion?: number; status?: string; source?: string; pluginId?: string | null; pluginIds?: string[]; candidates?: Array<{ pluginId: string; version: string; behaviorDigest: string }> } | undefined;
  if (selection?.scopeVersion !== 2) return run.metadata.pluginId === source.pluginId;
  const manual = selection.source === "explicit" || selection.source === "inherited";
  if (selection.status !== "resolved" || !Array.isArray(selection.pluginIds) || !Array.isArray(selection.candidates)
    || new Set(selection.pluginIds).size !== selection.pluginIds.length || selection.pluginIds.length !== selection.candidates.length
    || selection.candidates.some((item, index) => item?.pluginId !== selection.pluginIds![index])
    || (manual ? run.metadata.pluginId !== source.pluginId || selection.pluginId !== source.pluginId || selection.pluginIds.length !== 1
      : !["auto", "none"].includes(selection.source ?? "") || selection.pluginId !== null || run.metadata.pluginId !== null)) return false;
  const candidate = selection.candidates.find(item => item.pluginId === source.pluginId);
  return candidate?.version === source.pluginVersion && candidate.behaviorDigest === source.pluginDigest;
}
