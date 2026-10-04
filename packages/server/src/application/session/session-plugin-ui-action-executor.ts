import type { AgentEventInput } from "@vykor/core";
import { readPluginUiAction } from "@vykor/protocol";
import type { SessionStore } from "@vykor/services";
import type { SessionRunWorkContext } from "../../runtime/run-coordinator.js";
import type { DaemonOperationGate, DaemonOperationLease } from "../control/daemon-operation-gate.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { SessionPluginUiService } from "./session-plugin-ui-service.js";

export interface SessionPluginUiActionExecutorOptions {
  store: Pick<SessionStore, "sessions" | "runs" | "conversations">;
  transaction: SessionStore["transaction"];
  service: Pick<SessionPluginUiService, "prepareAction" | "assertActionState" | "settleAction">;
  operationGate: Pick<DaemonOperationGate, "enter">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
}

/** One checked Native tool in the existing session lane, with no model Input or Attempt. */
export class SessionPluginUiActionExecutor {
  constructor(private readonly options: SessionPluginUiActionExecutorOptions) {}

  async execute(runId: string, context: SessionRunWorkContext): Promise<void> {
    const { store, transaction, service, events } = this.options;
    const run = store.runs.getRun(runId);
    const action = run && readPluginUiAction(run.metadata);
    if (!run || !action || run.status !== "pending") return;
    let lease: DaemonOperationLease | undefined;
    let savingResult = false;
    const publish = (work: () => void) => {
      const checkpoint = events.checkpoint();
      work();
      events.publishSince(checkpoint);
    };
    try {
      const session = store.sessions.get(run.sessionId);
      if (!session) throw new Error("plugin_ui_session_missing");
      // The admission lease ends when its receipt returns; this lease lasts through settlement.
      lease = this.options.operationGate.enter({ sessionId: session.id, cwd: session.cwd });
      context.signal.throwIfAborted();
      const prepared = await service.prepareAction(session.id, action.instanceId, action.expectedRevision + 1, action.actionId, runId);
      context.signal.throwIfAborted();
      service.assertActionState(session.id, action.instanceId, action.expectedRevision + 1, runId);
      publish(() => store.runs.updateRun(runId, { status: "running" }));
      const messageId = `ui_message_${runId}`;
      const onToolEvent = async (event: AgentEventInput) => {
        if (event.type === "tool.started") {
          publish(() => transaction(() => {
            store.conversations.createMessage({ id: messageId, sessionId: session.id, role: "assistant", runId,
              metadata: { presentation: { kind: "plugin_ui_action" } } });
            store.conversations.upsertMessagePart({ id: `${messageId}_label`, sessionId: session.id, messageId,
              type: "text", status: "completed", text: `用户在插件中执行操作：${action.label}` });
            store.conversations.upsertMessagePart({ id: action.toolUseId, sessionId: session.id, messageId,
              type: "tool", status: "pending", toolUseId: action.toolUseId, toolName: action.toolName, input: action.args,
              metadata: { executionState: "not_started", outcome: "pending", toolCallId: action.toolUseId,
                toolAttemptId: `tool_attempt_${action.toolUseId}_1`, toolProgress: { phase: "preparing", executionState: "not_started" } } });
          }));
        } else if (event.type === "domain.event" && event.data.name === "tool.lifecycle" && event.data.payload?.phase === "running") {
          context.signal.throwIfAborted();
          service.assertActionState(session.id, action.instanceId, action.expectedRevision + 1, runId);
          publish(() => transaction(() => {
            const current = store.runs.getRun(runId)!;
            if (current.status !== "running") throw new Error("plugin_ui_run_not_active");
            store.runs.updateRun(runId, { metadata: { uiAction: { ...action, executionState: "unknown" } } });
            store.conversations.upsertMessagePart({ id: action.toolUseId, sessionId: session.id, messageId,
              type: "tool", status: "running", metadata: { executionState: "unknown", toolProgress: { phase: "running" } } });
          }));
        } else if (event.type === "domain.event" && event.data.name === "tool.lifecycle"
          && ["preparing", "waiting_permission", "queued"].includes(String(event.data.payload?.phase))) {
          publish(() => store.conversations.upsertMessagePart({ id: action.toolUseId, sessionId: session.id, messageId,
            type: "tool", metadata: { toolProgress: { phase: event.data.payload!.phase, executionState: "not_started" } } }));
        } else if (event.type === "tool.completed") {
          const result = event.data.result;
          const status = context.signal.aborted && result.executionState !== "completed" ? "interrupted"
            : result.executionState === "completed" && !result.isError ? "completed" : "failed";
          savingResult = true;
          publish(() => service.settleAction(runId, status, { result, completion: prepared.action.completion }));
          savingResult = false;
        }
      };
      await prepared.agent.runTool({ type: "tool_use", id: action.toolUseId, name: action.toolName, input: action.args }, {
        capabilityView: prepared.view,
        scope: { agentId: prepared.agent.id, sessionId: session.id, runId, inputId: runId,
          traceId: runId, cwd: session.cwd, signal: context.signal },
        onToolEvent,
      });
    } catch {
      // A failed final save cannot authorize replay; the committed before-invoke fact stays unknown.
      publish(() => service.settleAction(runId, context.signal.aborted ? "interrupted" : "failed", {
        error: savingResult ? "plugin_ui_result_save_failed" : "plugin_ui_action_failed",
      }));
    } finally {
      lease?.release();
    }
  }
}
