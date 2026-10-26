import type { ReconcileToolOperationRequest, ToolOperationSummary, ToolOperationReviewPreview } from "@vykor/domain-contracts/executions";
import type { ToolExecutionResult } from "@vykor/agent-contracts";
import type { ApplicationOwnerLease, ReconcileToolOperationInput, SessionStore } from "@vykor/services";
import { ApplicationError } from "../../../shared/application-error.js";

export interface ToolOperationReviewOptions {
  store: Pick<SessionStore, "transaction" | "assertApplicationOwner" | "sessions" | "runs" | "toolOperations">;
  ownerLease(): ApplicationOwnerLease;
  accepting(): boolean;
  reconcile(input: ReconcileToolOperationInput): unknown;
}
/** The authenticated host reviews old operations; no method executes or retries a tool. */
export class ToolOperationReviewService {
  private readonly atomic: SessionStore["transaction"];
  private readonly assertLease: SessionStore["assertApplicationOwner"];
  constructor(private readonly options: ToolOperationReviewOptions) {
    this.atomic = options.store.transaction.bind(options.store);
    this.assertLease = options.store.assertApplicationOwner.bind(options.store);
  }
  list(sessionId: string): ToolOperationSummary[] {
    return this.atomic(() => {
      this.ready(sessionId);
      const root = this.root(sessionId);
      return this.options.store.toolOperations.listReviewCandidates()
        .filter(row => this.root(row.sessionId) === root && (row.state === "unknown" || this.runEnded(row)))
        .map(row => this.withRecoveryHint(row));
    });
  }
  get(sessionId: string, operationId: string): ToolOperationReviewPreview {
    return this.atomic(() => {
      this.authorize(sessionId, operationId);
      return this.withRecoveryHint(this.options.store.toolOperations.getReviewPreview(operationId));
    });
  }
  reconcile(sessionId: string, operationId: string, input: ReconcileToolOperationRequest): ToolOperationSummary {
    return this.atomic(() => {
      const row = this.authorize(sessionId, operationId);
      this.validate(input);
      if (row.revision !== input.expectedRevision) throw new ApplicationError(409, "Tool operation revision conflict");
      if (row.state !== "unknown") throw new ApplicationError(409,
        this.withRecoveryHint(row).recoveryHint ?? "Only unknown operations may be reconciled");
      const run = this.options.store.runs.getRun(row.runId);
      if (!run || run.sessionId !== row.sessionId || run.status === "pending" || run.status === "running")
        throw new ApplicationError(409, "Original tool Run must have ended before review");
      try { this.options.reconcile({ ...input, operationId }); }
      catch (error) { throw new ApplicationError(409, error instanceof Error ? error.message : String(error)); }
      return this.options.store.toolOperations.getSummary(operationId)!;
    });
  }
  private runEnded(row: ToolOperationSummary): boolean {
    const run = this.options.store.runs.getRun(row.runId);
    return !run || (run.status !== "pending" && run.status !== "running");
  }
  private withRecoveryHint<T extends ToolOperationSummary>(row: T): T {
    if (row.state !== "dispatching") return row;
    const recoveryHint = this.runEnded(row)
      ? "原 Run 已结束，但工具回执尚未保存。先排查存储失败并等待仍在执行的调用结束；确认旧 daemon 停止后重启，完成启动恢复，再刷新记录进行人工核对。"
      : "原 Run 仍在进行，工具回执尚未保存。请等待实际调用结束，不能提前解除保护。";
    return { ...row, recoveryHint };
  }
  private validate(input: ReconcileToolOperationRequest): void {
    const invalid = (message: string): never => { throw new ApplicationError(400, message); };
    if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) invalid("expectedRevision must be a positive integer");
    if (!["applied", "not_applied", "unknown"].includes(input.outcome)) invalid("Invalid reconciliation outcome");
    if (typeof input.evidence !== "string" || !input.evidence.trim() || input.evidence.length > 8192) invalid("Non-empty evidence up to 8192 characters is required");
    if (input.result !== undefined) {
      const result = input.result as ToolExecutionResult;
      if (input.outcome !== "applied" || !result || result.executionState !== "completed"
        || typeof result.toolUseId !== "string" || typeof result.toolName !== "string" || !Array.isArray(result.content)
        || result.content.some(block => !block || (block.type !== "text" && block.type !== "image") || (block.type === "text" && typeof block.text !== "string")
          || (block.type === "image" && (!block.source || block.source.type !== "file" || typeof block.source.path !== "string" || typeof block.source.mediaType !== "string")))
        || (result.isError !== undefined && typeof result.isError !== "boolean")) invalid("Applied result must be an actual completed ToolExecutionResult");
      let size: number;
      try { size = JSON.stringify(result).length; } catch { return invalid("Result must be finite JSON data"); }
      if (size > 65536) invalid("Verified result exceeds 65536 characters");
    }
  }
  private ready(sessionId: string): void {
    this.assertLease(this.options.ownerLease());
    if (!this.options.accepting()) throw new ApplicationError(503, "Application is not accepting tool operation review");
    const session = this.options.store.sessions.get(sessionId);
    if (!session) throw new ApplicationError(404, "Tool review session not found");
    if (session.status === "closing" || session.status === "archived") throw new ApplicationError(409, "Tool review session is unavailable");
  }
  private authorize(sessionId: string, operationId: string): ToolOperationSummary {
    this.ready(sessionId);
    const row = this.options.store.toolOperations.getSummary(operationId);
    if (!row || this.root(row.sessionId) !== this.root(sessionId)) throw new ApplicationError(404, "Tool operation not found in this session tree");
    const target = this.options.store.sessions.get(row.sessionId);
    if (!target || target.status === "closing") throw new ApplicationError(409, "Tool operation session is unavailable");
    return row;
  }
  private root(sessionId: string): string {
    const visited = new Set<string>();
    let id = sessionId;
    for (;;) {
      if (visited.has(id)) throw new ApplicationError(409, "Tool session ancestry is cyclic");
      visited.add(id);
      const session = this.options.store.sessions.get(id);
      if (!session) throw new ApplicationError(404, "Tool session ancestry not found");
      if (!session.parentId) return id;
      id = session.parentId;
    }
  }
}
