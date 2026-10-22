import type { SessionStore } from "@vykor/services";
import { readPluginUiAction, readPluginUiInstance } from "@vykor/domain-contracts/plugin-apps/history";
export function retirePluginUiActions(store: SessionStore): void {
  store.transaction(() => {
    for (const session of store.sessions.list({ includeArchived: true })) {
      for (const run of store.runs.listRuns(session.id)) {
        const action = readPluginUiAction(run.metadata);
        if (!action || (run.status !== "pending" && run.status !== "running")) continue;
        const parts = store.conversations.listMessageParts(session.id);
        const tool = parts.find(part => part.id === action.toolUseId);
        const result = tool?.output && typeof tool.output === "object" ? tool.output as { executionState?: string; isError?: boolean } : undefined;
        const message = tool && store.conversations.listMessages(session.id).find(item => item.id === tool.messageId);
        const completed = message?.runId === run.id && result?.executionState === "completed";
        const executionState = completed ? "completed" : action.executionState === "not_started" ? "not_started" : "unknown";
        const status = executionState === "completed" ? result?.isError ? "failed" : "completed" : "interrupted";
        if (tool && tool.status !== "completed" && tool.status !== "failed") store.conversations.upsertMessagePart({ ...tool, status,
          metadata: { ...tool.metadata, executionState, outcome: status, toolProgress: null,
            ...(executionState === "unknown" ? { failureKind: "unknown_outcome" } : {}) } });
        for (const part of parts) {
          const instance = readPluginUiInstance(part.metadata);
          if (!instance || instance.activeActionRunId !== run.id) continue;
          const { activeActionRunId: _active, ...settled } = instance;
          store.conversations.upsertMessagePart({ ...part, metadata: { ...part.metadata,
            pluginUi: { ...settled, lastActionRunId: run.id, revision: instance.revision + 1, updatedAt: Date.now() } } });
        }
        store.runs.updateRun(run.id, { status, error: "plugin_ui_retired", metadata: { ...run.metadata, uiAction: { ...action, executionState } } });
      }
    }
  });
}
