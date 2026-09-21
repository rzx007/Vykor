export type DurableEventScope = "session" | "global";

export interface DurableEventDefinition {
  type: string;
  currentVersion: number;
  scope: DurableEventScope;
  validate(payload: Record<string, unknown>): void;
}

export interface PreparedDurableEvent {
  type: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
}

export class DurableEventRegistryError extends Error {
  constructor(
    readonly code: "unknown_type" | "invalid_scope" | "invalid_payload" | "unsupported_version",
    message: string,
    readonly eventType: string,
    readonly schemaVersion?: number,
  ) {
    super(message);
    this.name = "DurableEventRegistryError";
  }
}

export class DurableEventRegistry {
  private readonly definitions = new Map<string, DurableEventDefinition>();

  constructor(definitions: readonly DurableEventDefinition[]) {
    for (const definition of definitions) {
      if (!Number.isInteger(definition.currentVersion) || definition.currentVersion < 1) {
        throw new Error(`Durable event ${definition.type} has an invalid current version`);
      }
      if (this.definitions.has(definition.type)) {
        throw new Error(`Duplicate durable event registration: ${definition.type}`);
      }
      this.definitions.set(definition.type, definition);
    }
  }

  definition(type: string): DurableEventDefinition | undefined {
    return this.definitions.get(type);
  }

  prepareWrite(type: string, payload: Record<string, unknown>, sessionId?: string): PreparedDurableEvent {
    const definition = this.requireDefinition(type);
    this.validateScope(definition, sessionId);
    this.validatePayload(definition, payload);
    return { type, schemaVersion: definition.currentVersion, payload };
  }

  prepareRead(
    type: string,
    schemaVersion: number,
    payload: Record<string, unknown>,
    sessionId?: string,
  ): PreparedDurableEvent {
    const resolvedType = type;
    const resolvedPayload = payload;
    const definition = this.requireDefinition(type);
    this.validateScope(definition, sessionId);
    if (schemaVersion !== definition.currentVersion) {
      throw new DurableEventRegistryError(
        "unsupported_version",
        `Unsupported durable event schema version ${schemaVersion} for ${resolvedType}; current version is ${definition.currentVersion}`,
        resolvedType,
        schemaVersion,
      );
    }

    this.validatePayload(definition, resolvedPayload);
    return { type: resolvedType, schemaVersion, payload: resolvedPayload };
  }

  private requireDefinition(type: string): DurableEventDefinition {
    const definition = this.definitions.get(type);
    if (!definition) {
      throw new DurableEventRegistryError("unknown_type", `Unregistered durable event type: ${type}`, type);
    }
    return definition;
  }

  private validateScope(definition: DurableEventDefinition, sessionId?: string): void {
    const valid = definition.scope === "session" ? sessionId !== undefined : sessionId === undefined;
    if (!valid) {
      throw new DurableEventRegistryError(
        "invalid_scope",
        definition.scope === "session"
          ? `Durable event ${definition.type} requires a sessionId`
          : `Global durable event ${definition.type} cannot have a sessionId`,
        definition.type,
      );
    }
  }

  private validatePayload(definition: DurableEventDefinition, payload: Record<string, unknown>): void {
    try {
      definition.validate(payload);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new DurableEventRegistryError(
        "invalid_payload",
        `Invalid payload for durable event ${definition.type}: ${detail}`,
        definition.type,
        definition.currentVersion,
      );
    }
  }
}

function objectPayload(...fields: string[]): DurableEventDefinition["validate"] {
  return (payload) => {
    for (const field of fields) requireRecord(payload, field);
  };
}

function stringsPayload(...fields: string[]): DurableEventDefinition["validate"] {
  return (payload) => {
    for (const field of fields) requireString(payload, field);
  };
}

function arraysPayload(...fields: string[]): DurableEventDefinition["validate"] {
  return (payload) => {
    for (const field of fields) {
      if (!Array.isArray(payload[field])) throw new Error(`${field} must be an array`);
    }
  };
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function requireRecord(payload: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = payload[field];
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionDefinition(
  type: string,
  validate: DurableEventDefinition["validate"],
  currentVersion = 1,
): DurableEventDefinition {
  return { type, currentVersion, scope: "session", validate };
}

const workflowEventTypes = [
  "workflow_started",
  "task_started",
  "task_progress",
  "task_blocked",
  "workflow_budget_conserving",
  "workflow_budget_exceeded",
  "task_finished",
  "workflow_cancelled",
  "workflow_finished",
] as const;

export const DEFAULT_DURABLE_EVENT_DEFINITIONS: readonly DurableEventDefinition[] = [
  { type: "session.deleted", currentVersion: 1, scope: "global", validate: (payload) => {
    const ids = payload.sessionIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("sessionIds must be a non-empty string array");
    }
  } },
  { type: "scheduled.task.deleted", currentVersion: 1, scope: "global", validate: stringsPayload("taskId") },
  { type: "scheduled.run.created", currentVersion: 1, scope: "global", validate: objectPayload("run") },
  { type: "scheduled.run.updated", currentVersion: 1, scope: "global", validate: objectPayload("run") },
  sessionDefinition("session.created", objectPayload("session")),
  sessionDefinition("session.updated", objectPayload("session")),
  sessionDefinition("session.archived", stringsPayload("sessionId")),
  sessionDefinition("session.closing", stringsPayload("sessionId")),
  sessionDefinition("session.input.admitted", objectPayload("input"), 2),
  sessionDefinition("session.message.created", objectPayload("message")),
  sessionDefinition("session.transcript.replaced", arraysPayload("messages", "parts")),
  sessionDefinition("session.message.part.updated", objectPayload("part")),
  sessionDefinition("session.message.part.delta", (payload) => {
    stringsPayload("sessionId", "messageId", "partId", "field", "delta")(payload);
    if (payload.field !== "text" && payload.field !== "reasoning") throw new Error("field must be text or reasoning");
  }),
  sessionDefinition("session.run.created", objectPayload("run")),
  sessionDefinition("session.goal.created", objectPayload("goal")),
  sessionDefinition("session.goal.updated", objectPayload("goal")),
  sessionDefinition("session.run.updated", (payload) => {
    objectPayload("run")(payload);
    requireString(payload, "previousStatus");
  }),
  sessionDefinition("session.run_attempt.created", objectPayload("attempt")),
  sessionDefinition("session.run_attempt.updated", (payload) => {
    objectPayload("attempt")(payload);
    requireString(payload, "previousStatus");
  }),
  sessionDefinition("session.run.error", stringsPayload("runId", "error")),
  sessionDefinition("session.run.interrupted", stringsPayload("runId", "error")),
  sessionDefinition("session.run.interrupt_requested", (payload) => {
    if (payload.runId !== undefined && typeof payload.runId !== "string") throw new Error("runId must be a string");
    if (!Array.isArray(payload.queuedRunIds) || payload.queuedRunIds.some((id) => typeof id !== "string")) {
      throw new Error("queuedRunIds must be an array of strings");
    }
    requireString(payload, "reason");
  }),
  sessionDefinition("session.run.recovery_requested", (payload) => {
    stringsPayload("sourceRunId", "sourceInputId", "recoveryInputId")(payload);
    if (payload.recoveryRunId !== undefined && typeof payload.recoveryRunId !== "string") {
      throw new Error("recoveryRunId must be a string");
    }
  }),
  sessionDefinition("session.task.created", objectPayload("task")),
  sessionDefinition("session.task.updated", (payload) => {
    objectPayload("task")(payload);
    requireString(payload, "previousStatus");
  }),
  sessionDefinition("permission.asked", objectPayload("request")),
  sessionDefinition("permission.replied", objectPayload("request")),
  sessionDefinition("agent.child.suspended", stringsPayload("frameworkEventId", "childId", "childSessionId")),
  sessionDefinition("agent.child.resumed", stringsPayload("frameworkEventId", "childId", "childSessionId")),
  sessionDefinition("agent.child.closed", (payload) => {
    stringsPayload("frameworkEventId", "childId", "childSessionId")(payload);
    requireRecord(payload, "result");
  }),
  sessionDefinition("agent.permission.requested", (payload) => {
    stringsPayload("frameworkEventId", "requestId")(payload);
    requireRecord(payload, "request");
  }),
  sessionDefinition("agent.permission.resolved", (payload) => {
    stringsPayload("frameworkEventId", "requestId")(payload);
    requireRecord(payload, "decision");
  }),
  sessionDefinition("agent.domain.event", (payload) => {
    stringsPayload("frameworkEventId", "name")(payload);
    requireRecord(payload, "payload");
  }),
  ...workflowEventTypes.map((eventType) => sessionDefinition(`workflow.${eventType}`, (payload) => {
    const event = requireRecord(payload, "event");
    if (event.type !== eventType) throw new Error(`event.type must be ${eventType}`);
    if (
      payload.recoveredAfterDaemonRestart !== undefined &&
      typeof payload.recoveredAfterDaemonRestart !== "boolean"
    ) {
      throw new Error("recoveredAfterDaemonRestart must be a boolean");
    }
  })),
  sessionDefinition("workflow.workflow_recovery_failed", (payload) => {
    stringsPayload("runId", "error")(payload);
    if (payload.recoveredAfterDaemonRestart !== true) throw new Error("recoveredAfterDaemonRestart must be true");
  }),
];

export function createDurableEventRegistry(
  extensions: readonly DurableEventDefinition[] = [],
): DurableEventRegistry {
  return new DurableEventRegistry([...DEFAULT_DURABLE_EVENT_DEFINITIONS, ...extensions]);
}

export const defaultDurableEventRegistry = createDurableEventRegistry();
