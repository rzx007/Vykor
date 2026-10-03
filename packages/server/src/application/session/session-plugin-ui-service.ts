import { randomUUID } from "node:crypto";
import type { RunCapabilityView, RunPluginUiBinding, ToolResult } from "@vykor/core";
import {
  isCommittedModelPart, isPluginUiRecord, readPluginUiAction, readPluginUiInstance, readPluginUiProposal,
  type PluginUiAvailability, type PluginUiInstanceRecord, type PluginUiInstanceResponse,
  type SessionMessagePartRecord, type SessionRecord,
} from "@vykor/protocol";
import type { SessionStore } from "@vykor/services";
import { ApplicationError } from "../../shared/application-error.js";

/** Current host facts, resolved from install/settings/Runtime; never supplied by a client. */
export interface PluginUiCurrentState {
  enabled: boolean;
  uiEnabled: boolean;
  permissionsApproved: boolean;
  snapshot: "valid" | "missing" | "changed";
  binding?: RunPluginUiBinding;
  runtimeAvailable: boolean;
}

export interface SessionPluginUiServiceOptions {
  store: Pick<SessionStore, "sessions" | "conversations" | "runs">;
  resolveCurrent(session: SessionRecord, instance: PluginUiInstanceRecord): Promise<PluginUiCurrentState>;
  diagnose?(diagnostic: { code: "plugin_ui_invalid_result"; sessionId: string; runId: string; partId: string }): void;
}

export class SessionPluginUiService {
  private readonly runViews = new Map<string, RunCapabilityView>();

  constructor(private readonly options: SessionPluginUiServiceOptions) {}

  /** Host-only entry: pass the acquired Agent's captured view before submitMessage. */
  registerRunView(runId: string, view: RunCapabilityView): void {
    this.runViews.set(runId, view);
  }

  releaseRunView(runId: string): void {
    this.runViews.delete(runId);
  }

  /** Called synchronously after the source Part write, inside its existing transaction. */
  createInstance(input: {
    sessionId: string; runId: string; partId: string; toolUseId: string; toolName: string; result: ToolResult;
  }): PluginUiInstanceRecord | undefined {
    if (!input.result.metadata || !Object.hasOwn(input.result.metadata, "ui")) return undefined;
    const invalid = () => {
      // UI diagnostics must never change a successful business tool's outcome.
      try { this.options.diagnose?.({ code: "plugin_ui_invalid_result", sessionId: input.sessionId,
        runId: input.runId, partId: input.partId }); } catch { /* diagnostic sink is best effort */ }
      return undefined;
    };
    const proposal = readPluginUiProposal(input.result.metadata);
    const view = this.runViews.get(input.runId);
    const tool = view?.tools.get(input.toolName);
    const pluginId = tool?.source?.kind === "plugin" ? tool.source.id : undefined;
    const binding = pluginId && proposal ? view?.pluginUi?.get(`${pluginId}:${proposal.componentId}`) : undefined;
    const run = this.options.store.runs.getRun(input.runId);
    const part = this.options.store.conversations.listMessageParts(input.sessionId).find(p => p.id === input.partId);
    if (!proposal || !pluginId || tool?.ownerPluginId !== pluginId || view?.pluginId !== pluginId
      || !binding || binding.pluginId !== pluginId || binding.componentId !== proposal.componentId
      || binding.definition.id !== proposal.componentId || !run || run.sessionId !== input.sessionId
      || run.metadata.pluginId !== pluginId || Object.hasOwn(run.metadata, "uiAction")
      || input.result.isError || input.result.executionState !== "completed"
      || !input.result.content.some(block => block.type === "text" && block.text.trim().length > 0)
      || !part || !this.validSource(part, { sessionId: input.sessionId, sourceRunId: input.runId,
        sourcePartId: input.partId, sourceToolUseId: input.toolUseId, sourceToolName: input.toolName, pluginId })) return invalid();
    const existing = readPluginUiInstance(part.metadata);
    if (existing) return this.validSource(part, existing) ? existing : invalid();
    const timestamp = Date.now();
    const instance: PluginUiInstanceRecord = {
      schemaVersion: 1, instanceId: randomUUID(), sessionId: input.sessionId,
      sourceRunId: input.runId, sourcePartId: input.partId, sourceToolUseId: input.toolUseId, sourceToolName: input.toolName,
      pluginId, pluginVersion: binding.pluginVersion, pluginDigest: binding.pluginDigest,
      componentId: binding.componentId, componentDigest: binding.componentDigest,
      title: binding.definition.title, surfaces: [...binding.definition.surfaces],
      status: "open", revision: 1, data: structuredClone(proposal.data), createdAt: timestamp, updatedAt: timestamp,
    };
    return readPluginUiInstance({ pluginUi: instance }) ?? invalid();
  }

  async get(sessionId: string, instanceId: string): Promise<PluginUiInstanceResponse> {
    const session = this.options.store.sessions.get(sessionId);
    const part = session && this.options.store.conversations.listMessageParts(sessionId)
      .find(p => readPluginUiInstance(p.metadata)?.instanceId === instanceId);
    const instance = part && readPluginUiInstance(part.metadata);
    if (!session || !part || !instance || !this.validSource(part, instance)) {
      throw new ApplicationError(404, "找不到此会话中的插件界面", "plugin_ui_not_found");
    }
    let current: PluginUiCurrentState;
    try { current = await this.options.resolveCurrent(session, instance); }
    catch {
      // With no verified snapshot, even read-only HTML cannot safely be loaded.
      return { instance, actions: [], availability: { code: "runtime-unavailable", canRender: false, canInvoke: false } };
    }
    const availability = this.availability(session, instance, current);
    return { instance, availability, actions: availability.canRender
      ? current.binding!.definition.actions.map(({ id, label, tool, completion }) => {
        const target = current.binding!.actionTools.find(binding => binding.definition.name === tool)!;
        return { id, label, completion, toolName: target.definition.name, inputSchema: structuredClone(target.definition.inputSchema) };
      }) : [] };
  }

  private validSource(part: SessionMessagePartRecord, instance: Pick<PluginUiInstanceRecord,
    "sessionId" | "sourceRunId" | "sourcePartId" | "sourceToolUseId" | "sourceToolName" | "pluginId"
  >): boolean {
    const run = this.options.store.runs.getRun(instance.sourceRunId);
    const message = this.options.store.conversations.listMessages(instance.sessionId).find(m => m.id === part.messageId);
    return part.sessionId === instance.sessionId && part.id === instance.sourcePartId
      && part.type === "tool" && part.status === "completed" && part.isError !== true
      && part.metadata.executionState === "completed" && isCommittedModelPart(part)
      && isPluginUiRecord(part.output) && part.output.executionState === "completed" && part.output.isError !== true
      && part.toolUseId === instance.sourceToolUseId && part.toolName === instance.sourceToolName
      && run?.sessionId === instance.sessionId && run.metadata.pluginId === instance.pluginId && !Object.hasOwn(run.metadata, "uiAction")
      && message?.sessionId === instance.sessionId && message.role === "assistant" && message.runId === run.id;
  }

  private availability(session: SessionRecord, instance: PluginUiInstanceRecord, current: PluginUiCurrentState): PluginUiAvailability {
    const unavailable = (code: PluginUiAvailability["code"], canRender = false): PluginUiAvailability => ({ code, canRender, canInvoke: false });
    if (!current.enabled || !current.uiEnabled) return unavailable("plugin-disabled");
    if (!current.permissionsApproved) return unavailable("permission-missing");
    if (current.snapshot !== "valid") return unavailable(current.snapshot === "missing" ? "snapshot-missing" : "snapshot-changed");
    const binding = current.binding;
    if (!binding || binding.pluginId !== instance.pluginId || binding.componentId !== instance.componentId
      || binding.definition.id !== instance.componentId) return unavailable("invalid-definition");
    if (!binding.definition.actions.every(action => binding.actionTools.some(tool =>
      tool.definition.name === action.tool && tool.source?.kind === "plugin"
      && tool.source.id === instance.pluginId && tool.ownerPluginId === instance.pluginId))) return unavailable("invalid-definition");
    if (binding.pluginVersion !== instance.pluginVersion || binding.pluginDigest !== instance.pluginDigest
      || binding.componentDigest !== instance.componentDigest) return unavailable("snapshot-changed");
    const lastRun = instance.lastActionRunId ? this.options.store.runs.getRun(instance.lastActionRunId) : undefined;
    const lastAction = lastRun && lastRun.sessionId === session.id ? readPluginUiAction(lastRun.metadata) : undefined;
    if (lastAction?.instanceId === instance.instanceId && lastAction.executionState === "unknown") return unavailable("action-unknown", true);
    if (session.status === "archived" || session.status === "closing") return unavailable("session-archived", true);
    if (!current.runtimeAvailable) return unavailable("runtime-unavailable", true);
    return { code: "available", canRender: true, canInvoke: instance.status === "open" && !instance.activeActionRunId };
  }
}
