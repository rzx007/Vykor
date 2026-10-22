import {
  readPluginAppAction,
  type PluginAppToolRequest,
} from "@vykor/protocol";
import type { SessionStore } from "@vykor/services";
import type { SessionRunWorkContext } from "../../runtime/run-coordinator.js";
import type { DaemonOperationGate } from "../control/daemon-operation-gate.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { PluginAppOperationService } from "./plugin-app-operation-service.js";

export class PluginAppOperationExecutor {
  constructor(
    private readonly options: {
      store: SessionStore;
      service: PluginAppOperationService;
      operationGate: DaemonOperationGate;
      events: SessionEventPublisher;
    },
  ) {}
  async execute(
    runId: string,
    request: PluginAppToolRequest,
    context: SessionRunWorkContext,
  ): Promise<void> {
    const { store, service, events } = this.options;
    const run = store.runs.getRun(runId),
      action = run && readPluginAppAction(run.metadata);
    if (!run || !action || run.status !== "pending") return;
    const session = store.sessions.get(run.sessionId);
    if (!session) return;
    let lease: ReturnType<DaemonOperationGate["enter"]> | undefined,
      saving = false;
    const publish = (work: () => void) => {
      const before = events.checkpoint();
      work();
      events.publishSince(before);
    };
    try {
      lease = this.options.operationGate.enter({
        sessionId: session.id,
        cwd: session.cwd,
      });
      context.signal.throwIfAborted();
      const prepared = await service.prepare(runId, request);
      publish(() => store.runs.updateRun(runId, { status: "running" }));
      const messageId = `app_message_${runId}`;
      await prepared.host.plugins.runPluginAppTool(prepared.app, request, {
        scope: {
          agentId: prepared.agent.id,
          sessionId: session.id,
          runId,
          inputId: runId,
          traceId: runId,
          cwd: session.cwd,
          signal: context.signal,
        },
        onToolEvent: async (event) => {
          if (event.type === "tool.started") {
            publish(() =>
              store.transaction(() => {
                store.conversations.createMessage({
                  id: messageId,
                  sessionId: session.id,
                  role: "assistant",
                  runId,
                  metadata: { presentation: { kind: "plugin_app_action" } },
                });
                store.conversations.upsertMessagePart({
                  id: `${messageId}_label`,
                  sessionId: session.id,
                  messageId,
                  type: "text",
                  status: "completed",
                  text: `用户在插件 ${action.pluginId} 中执行：${action.toolName}`,
                });
                store.conversations.upsertMessagePart({
                  id: action.toolUseId,
                  sessionId: session.id,
                  messageId,
                  type: "tool",
                  status: "pending",
                  toolName: action.registeredToolName,
                  toolUseId: action.toolUseId,
                  input: action.args,
                  metadata: { executionState: "not_started" },
                });
              }),
            );
          } else if (
            event.type === "domain.event" &&
            event.data.name === "tool.lifecycle" &&
            event.data.payload?.phase === "running"
          ) {
            context.signal.throwIfAborted();
            await service.prepare(runId, request);
            context.signal.throwIfAborted();
            publish(() =>
              store.transaction(() => {
                service.assertState(
                  request.source,
                  action.acceptedRevision,
                  runId,
                );
                store.runs.updateRun(runId, {
                  metadata: {
                    pluginAppAction: { ...action, executionState: "unknown" },
                  },
                });
                store.conversations.upsertMessagePart({
                  id: action.toolUseId,
                  sessionId: session.id,
                  messageId,
                  type: "tool",
                  status: "running",
                  metadata: { executionState: "unknown" },
                });
              }),
            );
          } else if (event.type === "tool.completed") {
            saving = true;
            const result = event.data.result;
            publish(() =>
              service.settle(
                runId,
                result.executionState === "completed" && !result.isError
                  ? "completed"
                  : context.signal.aborted
                    ? "interrupted"
                    : "failed",
                result,
              ),
            );
            saving = false;
          }
        },
      });
    } catch {
      publish(() =>
        service.settle(
          runId,
          context.signal.aborted ? "interrupted" : "failed",
          undefined,
          saving ? "plugin_app_result_save_failed" : "plugin_app_action_failed",
        ),
      );
    } finally {
      lease?.release();
    }
  }
}
