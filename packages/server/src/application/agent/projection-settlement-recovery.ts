import type { AgentChildResult, AgentEvent } from "@openharness/core";
import type { SessionStore } from "@openharness/services";
import type {
  CreateProjectionSettlementInput,
  ProjectionSettlementRecord,
} from "@openharness/protocol";

export const DAEMON_AGENT_PROJECTOR = "daemon-agent";

export interface DaemonAgentSettlementPayload extends Record<string, unknown> {
  event: AgentEvent;
  cause: { name: string; message: string };
}

type SettlementStore = Pick<
  SessionStore,
  | "conversations"
  | "runs"
  | "sessions"
  | "createProjectionSettlement"
  | "failProjectionSettlement"
  | "getProjectionSettlement"
  | "getSessionTask"
  | "listProjectionSettlements"
  | "markProjectionSettlementRetrying"
  | "resolveProjectionSettlement"
  | "transaction"
  | "updateSessionTask"
>;

export function projectionSettlementInput(
  projector: string,
  rootSessionId: string,
  event: AgentEvent,
  action: CreateProjectionSettlementInput["action"],
  cause: unknown,
): CreateProjectionSettlementInput {
  const error = serializeError(cause);
  return {
    projector,
    rootSessionId,
    eventSequence: event.sequence,
    action,
    payload: { event, cause: error },
    error: error.message,
  };
}

export function decodeDaemonAgentSettlement(
  settlement: ProjectionSettlementRecord,
): { event: AgentEvent; cause: Error } {
  const event = settlement.payload.event;
  const cause = settlement.payload.cause;
  if (!isRecord(event) || typeof event.type !== "string" || typeof event.sequence !== "number") {
    throw new Error(`Projection settlement ${settlement.id} has an invalid Agent event`);
  }
  if (!isRecord(cause) || typeof cause.message !== "string") {
    throw new Error(`Projection settlement ${settlement.id} has an invalid cause`);
  }
  const error = new Error(cause.message);
  if (typeof cause.name === "string") error.name = cause.name;
  return { event: event as unknown as AgentEvent, cause: error };
}

export function recoverProjectionSettlements(
  store: SettlementStore,
  options: { projector?: string; rootSessionId?: string } = {},
): { resolved: number; pending: number } {
  const settlements = store.listProjectionSettlements({
    ...options,
    status: ["pending", "retrying"],
  });
  let resolved = 0;
  for (const settlement of settlements) {
    store.markProjectionSettlementRetrying(settlement.id);
    try {
      recoverOne(store, settlement);
      store.resolveProjectionSettlement(settlement.id);
      resolved += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        store.failProjectionSettlement(settlement.id, message);
      } catch (persistenceError) {
        throw new AggregateError(
          [error, persistenceError],
          `Projection settlement repair and failure persistence both failed: ${settlement.id}`,
        );
      }
    }
  }
  return {
    resolved,
    pending: store.listProjectionSettlements({
      ...options,
      status: ["pending", "retrying"],
    }).length,
  };
}

function recoverOne(store: SettlementStore, settlement: ProjectionSettlementRecord): void {
  const { event, cause } = decodeDaemonAgentSettlement(settlement);
  if (settlement.action === "retry-terminal-projection") {
    recoverChildTerminalProjection(store, event);
    return;
  }
  compensateChildProjection(store, event, cause.message);
}

function recoverChildTerminalProjection(store: SettlementStore, event: AgentEvent): void {
  if (event.type !== "child.closed") {
    throw new Error(`Terminal projection settlement requires child.closed, received ${event.type}`);
  }
  const result = event.data.result;
  validateChildResult(result);
  const task = store.getSessionTask(event.data.childId);
  if (!task) throw new Error(`Child task not found during settlement recovery: ${event.data.childId}`);

  if (
    task.status !== result.status ||
    task.output !== result.output ||
    (result.status === "failed" && task.error !== (result.error ?? result.output))
  ) {
    store.updateSessionTask(task.id, {
      status: result.status,
      output: result.output,
      ...(result.status === "failed" ? { error: result.error ?? result.output } : {}),
    });
  }
  appendFrameworkEventOnce(store, event, "agent.child.closed", {
    childId: event.data.childId,
    childSessionId: event.data.sessionId,
    result,
  });
}

function compensateChildProjection(store: SettlementStore, event: AgentEvent, message: string): void {
  const runId = event.context.runId;
  if (runId) {
    const run = store.runs.getRun(runId);
    if (run && (run.status === "pending" || run.status === "running")) {
      store.transaction(() => {
        appendRunErrorOnce(store, event, runId, message);
        store.runs.updateRun(runId, { status: "failed", error: message });
      });
    }
  }

  const childId = event.context.childId ?? (event.type === "child.created" ? event.data.childId : undefined);
  if (childId) {
    const task = store.getSessionTask(childId);
    if (task && (task.status === "pending" || task.status === "running")) {
      store.updateSessionTask(task.id, { status: "failed", output: message, error: message });
    }
  }

  if (event.type === "child.created") {
    const child = store.sessions.get(event.data.sessionId);
    if (child && child.status !== "archived") store.sessions.archive(child.id);
  }
}

function appendFrameworkEventOnce(
  store: SettlementStore,
  event: AgentEvent,
  type: string,
  payload: Record<string, unknown>,
): void {
  const exists = store.conversations.listEvents({ sessionId: event.context.sessionId }).some(
    (candidate) => candidate.type === type && candidate.payload.frameworkEventId === event.id,
  );
  if (!exists) {
    store.conversations.appendEvent({
      type,
      sessionId: event.context.sessionId,
      payload: { frameworkEventId: event.id, ...payload },
    });
  }
}

function appendRunErrorOnce(
  store: SettlementStore,
  event: AgentEvent,
  runId: string,
  message: string,
): void {
  const exists = store.conversations.listEvents({ sessionId: event.context.sessionId }).some(
    (candidate) =>
      candidate.type === "session.run.error" &&
      candidate.payload.runId === runId &&
      candidate.payload.projectionSettlementEventId === event.id,
  );
  if (!exists) {
    store.conversations.appendEvent({
      type: "session.run.error",
      sessionId: event.context.sessionId,
      payload: {
        runId,
        error: message,
        projectionFailure: true,
        projectionSettlementEventId: event.id,
        ...(event.context.traceId ? { traceId: event.context.traceId } : {}),
      },
    });
  }
}

function validateChildResult(value: unknown): asserts value is AgentChildResult {
  if (
    !isRecord(value) ||
    !["completed", "failed", "interrupted", "stopped"].includes(String(value.status)) ||
    typeof value.output !== "string"
  ) {
    throw new Error("Projection settlement child result is invalid");
  }
}

function serializeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
