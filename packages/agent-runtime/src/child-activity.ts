import type { AgentEvent, ChildActivitySnapshot, ChildPartialResult } from "@vykor/core";

const MAX_CHILD_ACTIVITY_TEXT = 2_000;
const MAX_CHILD_PARTIAL_TEXT = 12_000;

export interface ChildActivityState {
  snapshot: ChildActivitySnapshot;
  stagedText: string;
  toolNames: Map<string, string>;
  terminalPartial?: ChildPartialResult;
}

type ChildActivityRecord = {
  id: string;
  sessionId: string;
  activityRunId?: string;
  activity?: ChildActivityState;
};

/** Merge one trusted bus event into the child's bounded activity view. */
export function applyChildActivityEvent(record: ChildActivityRecord, event: AgentEvent): void {
  const { childId, runId } = event.context;
  if (childId !== record.id || !runId || runId !== record.activityRunId) return;
  let state = record.activity;
  if (state?.snapshot.runId !== runId) {
    state = {
      snapshot: { version: 1, runId, updatedAt: Date.now(), toolCalls: 0, modelTurns: 0 },
      stagedText: "",
      toolNames: new Map(),
    };
    record.activity = state;
  }
  const snapshot = state.snapshot;
  const at = Date.parse(event.occurredAt) || Date.now();
  switch (event.type) {
    case "output.generation.started":
      state.stagedText = "";
      return;
    case "output.text.delta":
      state.stagedText += event.data.delta;
      return;
    case "output.turn.completed":
      if (state.stagedText.length > 0) {
        snapshot.latestAssistantText = state.stagedText.slice(0, MAX_CHILD_ACTIVITY_TEXT);
      }
      state.stagedText = "";
      snapshot.modelTurns++;
      snapshot.updatedAt = at;
      return;
    case "tool.started":
      state.toolNames.set(event.data.toolUse.id, event.data.toolUse.name);
      snapshot.latestTool = { name: event.data.toolUse.name, status: "running", at };
      snapshot.toolCalls++;
      snapshot.updatedAt = at;
      return;
    case "tool.completed": {
      const name = state.toolNames.get(event.data.toolUseId);
      if (name) {
        snapshot.latestTool = {
          name,
          status: event.data.result.isError ? "failed" : "completed",
          at,
        };
      }
      snapshot.updatedAt = at;
      return;
    }
    case "run.failed":
    case "run.interrupted":
      state.stagedText = "";
      state.terminalPartial = event.data.partialResult;
      snapshot.updatedAt = at;
      return;
    case "usage.updated": {
      const usage = event.data.usage;
      snapshot.usage = {
        ...(snapshot.usage ?? { incomplete: false }),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        incomplete: snapshot.usage?.incomplete === true || usage.usageIncomplete === true,
      };
      snapshot.updatedAt = at;
      return;
    }
    case "model.attempt.finished":
      if (event.data.usageStatus !== "complete") {
        snapshot.usage = { ...(snapshot.usage ?? {}), incomplete: true };
        snapshot.updatedAt = at;
      }
      return;
    default:
      return;
  }
}

export function partialResultFields(
  record: Pick<ChildActivityRecord, "sessionId" | "activity">,
  runId: string,
  finalizationText?: string,
): { partialResult?: ChildPartialResult } {
  const terminalPartial = record.activity?.snapshot.runId === runId
    ? record.activity.terminalPartial
    : undefined;
  if (terminalPartial) return { partialResult: terminalPartial };
  const finalization = finalizationText && finalizationText.length > 0 ? finalizationText : undefined;
  const committed = finalization
    ?? (record.activity?.snapshot.runId === runId
      ? record.activity.snapshot.latestAssistantText
      : undefined);
  if (!committed) return {};
  const truncated = committed.length > MAX_CHILD_PARTIAL_TEXT;
  return {
    partialResult: {
      version: 1,
      childSessionId: record.sessionId,
      runId,
      source: finalization ? "limit_finalization" : "committed_assistant_text",
      text: truncated ? committed.slice(0, MAX_CHILD_PARTIAL_TEXT) : committed,
      truncated,
    },
  };
}
