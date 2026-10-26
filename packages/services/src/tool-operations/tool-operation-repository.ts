import type { StoredToolOperationIntent } from "./commands.js";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ToolDispatchReceipt, ToolExecutionResult, ToolOperationKind, ToolOperationTicket } from "@vykor/agent-contracts/tool-data";
import type { ToolDispatchAttemptRecord, ToolOperationRecord, ToolOperationSummary, ToolOperationReviewPreview, ReconcileToolOperationRequest } from "@vykor/domain-contracts/executions";
import type { StorageContext } from "../database/storage-context.js";
import { ExecutionRepository, type ExecutionFilter } from "../execution-records/execution-repository.js";
import { assertMutableSession, assertSession, clone } from "../session-runtime/persistence/store-state.js";
import { applicationOwners } from "../session-runtime/schema.js";
import { toolResultText } from "@vykor/agent-contracts/tool-data";

export type ToolOperationSafetyState = Pick<ToolOperationRecord, "id" | "sessionId" | "runId" | "kind" | "state">;
export type ToolResultCandidate = Pick<ToolOperationRecord, "operationId" | "activeAttemptId" | "sessionId" | "runId" | "toolCallId" | "toolName" | "toolIdentity">;

function resultCandidate(row: ToolOperationRecord): ToolResultCandidate | undefined {
  if ((row.state !== "confirmed" && row.state !== "not_applied") || row.result?.executionState !== "completed") return;
  const { operationId, activeAttemptId, sessionId, runId, toolCallId, toolName, toolIdentity } = row;
  return { operationId, activeAttemptId, sessionId, runId, toolCallId, toolName, toolIdentity };
}

export type PrepareToolOperationInput = StoredToolOperationIntent & {
  kind?: ToolOperationKind;
  businessKey?: string;
  toolIdentity: string;
};
function summary(row: ToolOperationRecord): ToolOperationSummary {
  const { operationId, sessionId, runId, executionId, toolCallId, toolName, kind, state, revision, createdAt, updatedAt } = row;
  return { operationId, sessionId, runId, executionId, toolCallId, toolName, kind, state, revision, createdAt, updatedAt };
}

export interface ReconcileToolOperationInput extends ReconcileToolOperationRequest {
  operationId: string;
}

/** 有序 JSON 同时用于摘要和重复回执比较，不包含宿主函数、signal 或绑定定义。 */
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Tool operation requires finite JSON data");
}
function digest(intent: StoredToolOperationIntent, description: { kind: ToolOperationKind; toolIdentity: string; businessKey?: string }): string {
  const { sessionId, runId, agentId, inputId, cwd } = intent.scope;
  return createHash("sha256").update(canonical({ sessionId, runId, agentId, inputId, cwd,
    toolCallId: intent.toolUse.id, generationId: intent.generationId, toolName: intent.toolUse.name, input: intent.toolUse.input,
    parentOperationId: intent.parentOperationId, kind: description.kind, toolIdentity: description.toolIdentity, businessKey: description.businessKey,
  })).digest("hex");
}
function ticket(row: ToolOperationRecord): ToolOperationTicket {
  return clone({ operationId: row.operationId, revision: row.revision, intentRevision: row.intentRevision,
    intentDigest: row.intentDigest, kind: row.kind, state: row.state,
    ...(row.businessKey === undefined ? {} : { businessKey: row.businessKey }), ...(row.result === undefined ? {} : { result: row.result }),
  });
}

export class ToolOperationRepository {
  constructor(private readonly storage: StorageContext, private readonly executions = new ExecutionRepository(storage)) {}

  private current(operation: ToolOperationTicket, intent: StoredToolOperationIntent): ToolOperationRecord {
    const row = this.require(operation.operationId);
    if (row.revision !== operation.revision) throw new Error("Tool operation revision conflict");
    if (row.intentDigest !== operation.intentDigest || row.intentRevision !== operation.intentRevision || row.kind !== operation.kind || row.state !== operation.state || digest(intent, row) !== row.intentDigest) throw new Error("Tool operation intent conflict");
    return row;
  }
  private require(id: string): ToolOperationRecord {
    const row = this.storage.state.toolOperations[id];
    if (!row) throw new Error(`Tool operation not found: ${id}`);
    return row;
  }
  private mutable(row: ToolOperationRecord): void {
    this.storage.rollback?.capture(this.storage.state.toolOperations, row.id);
    this.storage.mutations.toolOperations.add(row.id);
    row.revision++;
    row.updatedAt = Date.now();
  }
  private mutableAttempt(attempt: ToolDispatchAttemptRecord): void {
    this.storage.rollback?.capture(this.storage.state.toolDispatchAttempts, attempt.id);
    this.storage.mutations.toolDispatchAttempts.add(attempt.id);
  }
  private dispatchable(row: ToolOperationRecord): void {
    assertMutableSession(assertSession(this.storage.state, row.sessionId));
    const run = this.storage.state.runs[row.runId];
    if (!run || run.sessionId !== row.sessionId || (run.status !== "pending" && run.status !== "running")) throw new Error("Tool operation Run is terminal or does not belong to session");
  }
  private validateResult(row: ToolOperationRecord, result: ToolExecutionResult, attemptId?: string): void {
    if (result.toolUseId !== row.toolCallId || result.toolName !== row.toolName || (result.operationId !== undefined && result.operationId !== row.id) || (result.toolAttemptId !== undefined && result.toolAttemptId !== attemptId)) throw new Error("Tool result identity does not match operation receipt");
    canonical(result);
  }

  prepare(input: PrepareToolOperationInput): ToolOperationTicket {
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      if (!input.toolIdentity.trim()) throw new Error("Tool identity is required");
      if (input.kind === "idempotent_write" && !input.businessKey?.trim()) throw new Error("Idempotent writes require a stable business key");
      const description = { kind: input.kind ?? "non_replayable", toolIdentity: input.toolIdentity, businessKey: input.businessKey };
      const intentDigest = digest(input, description);
      const existing = Object.values(this.storage.state.toolOperations).find(row => row.sessionId === input.scope.sessionId && row.runId === input.scope.runId && row.toolCallId === input.toolUse.id && row.generationId === input.generationId);
      if (existing) {
        if (existing.intentDigest !== intentDigest) throw new Error("Tool operation intent conflict");
        return ticket(existing);
      }
      const execution = this.executions.ensure({ sessionId: input.scope.sessionId, runId: input.scope.runId });
      if (input.parentOperationId) {
        const parent = this.require(input.parentOperationId);
        if (parent.sessionId !== input.scope.sessionId || parent.runId !== input.scope.runId) throw new Error("Parent operation scope conflict");
      }
      const id = `operation_${randomUUID()}`;
      const timestamp = Date.now();
      const row: ToolOperationRecord = {
        id, operationId: id, sessionId: input.scope.sessionId, runId: input.scope.runId,
        executionId: execution.id, agentId: input.scope.agentId, inputId: input.scope.inputId, traceId: input.scope.traceId, cwd: input.scope.cwd,
        toolCallId: input.toolUse.id, toolName: input.toolUse.name, toolIdentity: input.toolIdentity,
        ...(input.generationId ? { generationId: input.generationId } : {}),
        normalizedInput: JSON.parse(canonical(input.toolUse.input)) as Record<string, unknown>,
        ...(input.parentOperationId ? { parentOperationId: input.parentOperationId } : {}),
        ...(input.businessKey === undefined ? {} : { businessKey: input.businessKey }),
        kind: description.kind, state: "prepared", revision: 1, intentRevision: 1, intentDigest, createdAt: timestamp, updatedAt: timestamp,
      };
      this.dispatchable(row);
      this.storage.rollback?.capture(this.storage.state.toolOperations, id);
      this.storage.state.toolOperations[id] = row;
      this.storage.mutations.toolOperations.add(id);
      return ticket(row);
    });
  }

  authorize(input: { intent: StoredToolOperationIntent; operation: ToolOperationTicket; policyVersion: string }): ToolOperationTicket {
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      const row = this.current(input.operation, input.intent);
      this.dispatchable(row);
      if (!["prepared", "authorized", "not_applied"].includes(row.state)) throw new Error(`Cannot authorize ${row.state} operation`);
      if (!input.policyVersion.trim()) throw new Error("Policy version is required");
      this.mutable(row);
      row.state = "authorized";
      row.policyVersion = input.policyVersion;
      delete row.result;
      return ticket(row);
    });
  }

  dispatch(input: { intent: StoredToolOperationIntent; operation: ToolOperationTicket; policyVersion: string; ownerId: string }): ToolDispatchReceipt {
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      const row = this.current(input.operation, input.intent);
      this.dispatchable(row);
      if (input.intent.scope.signal?.aborted) throw new Error("Tool operation Run is cancelled");
      if (row.state !== "authorized") throw new Error(`Cannot dispatch ${row.state} operation`);
      if (!input.policyVersion.trim() || row.policyVersion !== input.policyVersion) throw new Error("Tool operation policy version conflict");
      if (!input.ownerId.trim()) throw new Error("Tool dispatch owner is required");
      const owner = this.storage.database.orm.select().from(applicationOwners).where(eq(applicationOwners.key, "application")).get();
      if (owner && owner.ownerId !== input.ownerId) throw new Error("Tool dispatch owner is no longer active");
      if (row.kind !== "read_only" && Object.values(this.storage.state.toolOperations).some(other => {
        if (other.sessionId !== row.sessionId || other.kind === "read_only") return false;
        if (other.state === "unknown") return true;
        const otherRun = this.storage.state.runs[other.runId];
        return other.state === "dispatching" && other.runId !== row.runId && (!otherRun || (otherRun.status !== "pending" && otherRun.status !== "running"));
      })) throw new Error("Unknown or unsettled write operation blocks dangerous dispatch");
      this.mutable(row);
      const toolAttemptId = `tool_attempt_${randomUUID()}`;
      row.state = "dispatching";
      row.activeAttemptId = toolAttemptId;
      const receipt: ToolDispatchReceipt = { operationId: row.id, toolAttemptId, revision: row.revision, ownerId: input.ownerId };
      const attempt: ToolDispatchAttemptRecord = { ...receipt, id: toolAttemptId, sessionId: row.sessionId, runId: row.runId, executionId: row.executionId, status: "dispatching", startedAt: Date.now() };
      this.storage.rollback?.capture(this.storage.state.toolDispatchAttempts, toolAttemptId);
      this.storage.state.toolDispatchAttempts[toolAttemptId] = attempt;
      this.storage.mutations.toolDispatchAttempts.add(toolAttemptId);
      return clone(receipt);
    });
  }

  settle(input: { receipt: ToolDispatchReceipt; result: ToolExecutionResult; late?: boolean }): void {
    this.storage.atomic(() => {
      this.storage.assertWritable();
      const row = this.require(input.receipt.operationId);
      const attempt = this.storage.state.toolDispatchAttempts[input.receipt.toolAttemptId];
      if (!attempt || attempt.operationId !== row.id || attempt.revision !== input.receipt.revision || attempt.ownerId !== input.receipt.ownerId || row.activeAttemptId !== attempt.id) throw new Error("Tool dispatch receipt conflict");
      this.validateResult(row, input.result, attempt.id);
      if (attempt.result && canonical(attempt.result) === canonical(input.result)) return;
      const state = input.result.executionState === "unknown" ? "unknown" : input.result.executionState === "not_started" ? "not_applied" : "confirmed";
      if (attempt.result && !(attempt.status === "unknown" && state === "confirmed" && input.late)) throw new Error("Tool result conflicts with saved receipt");
      // Manual absence observations cannot override the same attempt's later actual completion.
      if (row.state !== "dispatching" && !((row.state === "unknown" || row.state === "not_applied") && state === "confirmed" && input.late)) throw new Error(`Cannot settle ${row.state} operation`);
      this.mutable(row); this.mutableAttempt(attempt);
      row.state = state;
      row.result = clone(input.result);
      attempt.status = state;
      attempt.result = clone(input.result);
      attempt.finishedAt = Date.now();
    });
  }

  reject(input: { intent: StoredToolOperationIntent; operation: ToolOperationTicket; result: ToolExecutionResult }): void {
    this.storage.atomic(() => {
      this.storage.assertWritable();
      const row = this.current(input.operation, input.intent);
      if (!["prepared", "authorized", "not_applied"].includes(row.state)) throw new Error(`Cannot reject ${row.state} operation`);
      if (input.result.executionState !== "not_started" || input.result.isError !== true) throw new Error("Tool operation rejection requires a failed not_started result");
      this.validateResult(row, input.result);
      this.mutable(row);
      row.state = input.result.failureKind === "interrupted" ? "cancelled" : "rejected";
      row.result = clone(input.result);
    });
  }

  get(operationId: string): ToolOperationRecord | undefined { const row = this.storage.state.toolOperations[operationId]; return row && clone(row); }
  /** Safety checks never need normalized inputs, receipts or result bodies. */
  listSafetyStates(): ToolOperationSafetyState[] {
    return Object.values(this.storage.state.toolOperations).map(({ id, sessionId, runId, kind, state }) => ({ id, sessionId, runId, kind, state }));
  }
  getResultCandidate(operationId: string): ToolResultCandidate | undefined {
    const row = this.storage.state.toolOperations[operationId];
    return row && resultCandidate(row);
  }
  listResultCandidates(sessionId: string): ToolResultCandidate[] {
    return Object.values(this.storage.state.toolOperations).flatMap(row => {
      const candidate = row.sessionId === sessionId ? resultCandidate(row) : undefined;
      return candidate ? [candidate] : [];
    });
  }
  /** Only call after candidate authorization/pagination; no Operation or Attempt body copy. */
  readResultText(operationId: string): string {
    const row = this.storage.state.toolOperations[operationId];
    if (!row?.result || !resultCandidate(row)) throw new Error("Complete tool result is unavailable");
    return toolResultText(row.result);
  }
  list(filter: ExecutionFilter = {}): ToolOperationRecord[] {
    return clone(Object.values(this.storage.state.toolOperations).filter(row => (!filter.sessionId || row.sessionId === filter.sessionId) && (!filter.runId || row.runId === filter.runId)));
  }
  getSummary(operationId: string): ToolOperationSummary | undefined {
    const row = this.storage.state.toolOperations[operationId];
    return row && summary(row);
  }
  /** Projects finite identity fields before cloning; never copies full output into a listing. */
  listReviewCandidates(): ToolOperationSummary[] {
    return Object.values(this.storage.state.toolOperations).filter(row => row.state === "unknown" || row.state === "dispatching").map(summary);
  }
  getReviewPreview(operationId: string): ToolOperationReviewPreview {
    const row = this.require(operationId);
    return { ...summary(row), ...(row.activeAttemptId ? { activeAttemptId: row.activeAttemptId } : {}),
      inputPreview: JSON.stringify(row.normalizedInput).slice(0, 4000),
      ...(row.result ? { resultPreview: JSON.stringify(row.result).slice(0, 4000) } : {}),
      reconciliations: (row.reconciliations ?? []).slice(-20).map(item => ({ ...item, evidence: item.evidence.slice(0, 4000) })),
    };
  }
  listAttempts(operationId: string): ToolDispatchAttemptRecord[] {
    return clone(Object.values(this.storage.state.toolDispatchAttempts).filter(row => row.operationId === operationId).sort((a, b) => a.startedAt - b.startedAt));
  }

  /** 仅在宿主已确认旧 owner 失活后调用，不恢复模型、不重新调用工具。 */
  recoverDispatching(): number {
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      let recovered = 0;
      for (const row of Object.values(this.storage.state.toolOperations)) {
        if (row.state !== "dispatching") continue;
        const attempt = row.activeAttemptId && this.storage.state.toolDispatchAttempts[row.activeAttemptId];
        this.mutable(row); row.state = "unknown";
        if (attempt) { this.mutableAttempt(attempt); attempt.status = "unknown"; attempt.finishedAt = Date.now(); }
        recovered++;
      }
      return recovered;
    });
  }

  reconcile(input: ReconcileToolOperationInput): ToolOperationTicket {
    return this.storage.atomic(() => {
      this.storage.assertWritable();
      const row = this.require(input.operationId);
      if (row.revision !== input.expectedRevision) throw new Error("Tool operation revision conflict");
      if (row.state !== "unknown") throw new Error("Only unknown operations may be reconciled");
      if (!input.evidence.trim()) throw new Error("Reconciliation evidence is required");
      if (input.result) this.validateResult(row, input.result, row.activeAttemptId);
      this.mutable(row);
      row.reconciliation = { outcome: input.outcome, evidence: input.evidence, at: Date.now() };
      row.reconciliations = [...(row.reconciliations ?? []), row.reconciliation];
      const attempt = row.activeAttemptId && this.storage.state.toolDispatchAttempts[row.activeAttemptId];
      if (attempt) {
        this.mutableAttempt(attempt);
        attempt.reconciliations = [...(attempt.reconciliations ?? []), clone(row.reconciliation)];
      }
      if (input.outcome === "not_applied") { row.state = "not_applied"; delete row.result; }
      if (input.outcome === "applied" && input.result && input.result.executionState === "completed") {
        row.state = "confirmed"; row.result = clone(input.result);
      }
      return ticket(row);
    });
  }
}
