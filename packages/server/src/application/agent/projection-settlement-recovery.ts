import type {
  AgentChildResult,
  ChildFailureKind,
  ChildPartialResult,
} from "@vykor/agent-contracts";
import type { AgentEvent } from "@vykor/agent-contracts";
import type { SessionStore } from "@vykor/services";
import type { CreateProjectionSettlementInput } from "@vykor/services";
import type { ProjectionSettlementRecord } from "@vykor/domain-contracts/sessions";

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
> & Partial<Pick<SessionStore, "conversationTransactions">>;

export type ProcessSettlementStore = Pick<SettlementStore,
  "createProjectionSettlement" | "listProjectionSettlements" | "markProjectionSettlementRetrying" |
  "resolveProjectionSettlement" | "failProjectionSettlement" | "getSessionTask" | "updateSessionTask">;

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
  store: SettlementStore | ProcessSettlementStore,
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

function recoverOne(store: SettlementStore | ProcessSettlementStore, settlement: ProjectionSettlementRecord): void {
  if (settlement.projector.startsWith("process-terminal:") && settlement.action === "retry-terminal-projection") {
    recoverProcessTerminalProjection(store, settlement);
    return;
  }
  if (!("runs" in store)) throw new Error("Agent projection recovery requires the original Agent store");
  const { event, cause } = decodeDaemonAgentSettlement(settlement);
  if (settlement.action === "retry-terminal-projection") {
    recoverChildTerminalProjection(store, event);
    return;
  }
  compensateChildProjection(store, event, cause.message);
}

function recoverChildTerminalProjection(store: SettlementStore, event: AgentEvent): void {
  if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.interrupted") {
    recoverRunTerminalProjection(store, event);
    return;
  }
  if (event.type !== "child.closed") {
    throw new Error(`Terminal projection settlement requires child.closed, received ${event.type}`);
  }
  const result = event.data.result;
  validateChildResult(result);
  const task = store.getSessionTask(event.data.childId);
  if (!task) throw new Error(`Child task not found during settlement recovery: ${event.data.childId}`);
  const failure = childFailureMetadata(result);

  if (
    task.status !== result.status ||
    task.output !== result.output ||
    (result.status === "failed" && task.error !== (result.error ?? result.output))
  ) {
    store.updateSessionTask(task.id, {
      status: result.status,
      output: result.output,
      ...(result.status === "failed" ? { error: result.error ?? result.output } : {}),
      ...(failure ? { metadata: { childFailure: failure } } : {}),
    });
  }
  appendFrameworkEventOnce(store, event, "agent.child.closed", {
    childId: event.data.childId,
    childSessionId: event.data.sessionId,
    result,
  });
}

function recoverRunTerminalProjection(store: SettlementStore, event: Extract<AgentEvent, { type: "run.completed" | "run.failed" | "run.interrupted" }>): void {
  const runId = event.context.runId;
  if (!runId || !store.runs.getRun(runId)) throw new Error(`Original run not found during terminal recovery: ${runId}`);
  const status = event.type === "run.completed" ? "completed" : event.type === "run.failed" ? "failed" : "interrupted";
  const error = event.type === "run.completed" ? undefined : event.data.error.message;
  const output = event.data.output ?? "";
  store.transaction(() => {
    const run = store.runs.getRun(runId)!;
    if (run.metadata.terminalFrameworkEventId !== event.id) {
      const messageIds = new Set(store.conversations.listMessages(run.sessionId).filter(message => message.runId === runId).map(message => message.id));
      for (const part of store.conversations.listMessageParts(run.sessionId)) {
        if (!messageIds.has(part.messageId) || !["pending", "running"].includes(part.status)) continue;
        store.conversations.upsertMessagePart({ ...part, status });
      }
      store.conversationTransactions?.settleActiveRunAttempts(runId, status === "interrupted" ? "cancelled" : status, error);
      store.runs.updateRun(runId, { status, ...(error ? { error } : {}), metadata: {
        terminalFrameworkEventId: event.id, terminalOutput: output, toolGeneration: [], modelRetry: null,
        ...(event.type === "run.completed" ? { ...(event.data.delivery ? { delivery: event.data.delivery } : {}), ...(event.data.stopReason ? { stopReason: event.data.stopReason } : {}) } : { childFailure: childFailureFromEvent(event) }),
      } });
    }
    const task = event.context.childId ? store.getSessionTask(event.context.childId) : undefined;
    if (task?.runId === runId && (task.status !== status || task.output !== output)) store.updateSessionTask(task.id, {
      status, output, ...(error ? { error } : {}), ...(childFailureFromEvent(event) ? { metadata: { childFailure: childFailureFromEvent(event) } } : {}),
    });
    if (error) appendFrameworkEventOnce(store, event, status === "interrupted" ? "session.run.interrupted" : "session.run.error", { runId, error });
  });
}

function recoverProcessTerminalProjection(store: ProcessSettlementStore, settlement: ProjectionSettlementRecord): void {
  const { execution, durableTaskId } = settlement.payload;
  if (!isRecord(execution) || typeof execution.id !== "string" || settlement.projector !== `process-terminal:${execution.id}` || typeof durableTaskId !== "string" ||
      !["completed", "failed", "stopped", "interrupted"].includes(String(execution.status)) || typeof execution.output !== "string") throw new Error(`Invalid process terminal save payload: ${settlement.id}`);
  const task = store.getSessionTask(durableTaskId);
  if (!task) throw new Error(`Process task not found: ${durableTaskId}`);
  store.updateSessionTask(durableTaskId, { status: execution.status as "completed" | "failed" | "stopped" | "interrupted", output: execution.output,
    ...(execution.status === "failed" ? { error: execution.output || "Task failed" } : {}),
    ...(isRecord(execution.metadata) ? { metadata: execution.metadata } : {}),
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
      const failure = childFailureFromEvent(event);
      store.updateSessionTask(task.id, {
        status: "failed",
        output: message,
        error: message,
        ...(failure ? { metadata: { childFailure: failure } } : {}),
      });
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

type ChildFailureMetadata = { failureKind?: ChildFailureKind; partialResult?: ChildPartialResult };

/** Preserve trusted terminal detail so compensation never replaces it with a generic error. */
function childFailureFromEvent(event: AgentEvent): ChildFailureMetadata | undefined {
  if (event.type !== "run.failed" && event.type !== "run.interrupted") return undefined;
  const metadata: ChildFailureMetadata = {};
  if (event.data.failureKind !== undefined) metadata.failureKind = event.data.failureKind;
  if (event.data.partialResult !== undefined) metadata.partialResult = event.data.partialResult;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function childFailureMetadata(result: AgentChildResult): ChildFailureMetadata | undefined {
  const metadata: ChildFailureMetadata = {};
  if (result.failureKind !== undefined) metadata.failureKind = result.failureKind;
  if (result.partialResult !== undefined) metadata.partialResult = result.partialResult;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function validateChildResult(value: unknown): asserts value is AgentChildResult {  if (
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
