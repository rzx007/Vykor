import { getSessionStorage } from "@vykor/domain-contracts/sessions";
import type { ApprovalMode, ApprovalReviewOutcome } from "@vykor/agent-contracts/permissions";
import type { ApprovalReviewRecord } from "@vykor/domain-contracts/approvals";
import type { PermissionRequestRecord, PermissionStatus } from "@vykor/domain-contracts/sessions";
import type { SessionStore } from "@vykor/services";
import type { AgentPermissionDecision } from "@vykor/agent-contracts";
import type { StructuredLogger } from "../shared/observability.js";
import { PermissionController } from "./permission-controller.js";

export type PermissionReplyStatus = Extract<PermissionStatus, "approved" | "denied" | "expired">;
export type PermissionDecisionScope = "once" | "session";

export interface PermissionAskInput {
  sessionId: string;
  runId?: string;
  traceId?: string;
  toolName: string;
  reason?: string;
  input?: Record<string, unknown>;
  signal?: AbortSignal;
  approvalMode?: ApprovalMode;
  runtimeRevision?: number;
  inputId?: string;
  /** Host-owned check against the current run and session configuration revision. */
  isCurrent?: () => boolean;
  review?: PermissionApprovalReviewHook;
}

export type PermissionApprovalReviewHook = (context: {
  request: PermissionRequestRecord;
  input: PermissionAskInput;
  signal?: AbortSignal;
}) => Promise<ApprovalReviewOutcome>;

export interface PermissionReplyInput {
  requestId: string;
  traceId?: string;
  status: PermissionReplyStatus;
  decision?: PermissionDecisionScope;
  clientId?: string;
  answer?: string;
}

export interface ListPermissionRequestsInput {
  sessionId?: string;
  status?: PermissionStatus;
  toolName?: string;
  limit?: number;
}

export interface PermissionBroker {
  ask(input: PermissionAskInput): Promise<AgentPermissionDecision>;
  reply(input: PermissionReplyInput): PermissionRequestRecord;
  getRequest(requestId: string): PermissionRequestRecord | undefined;
  listRequests(input?: ListPermissionRequestsInput): PermissionRequestRecord[];
}

export interface StorePermissionBrokerOptions {
  permissions: Pick<SessionStore["permissions"], "create" | "reply" | "updatePayload" | "expirePending" | "get" | "list">;
  getSession: SessionStore["sessions"]["get"];
  latestEventSeq: SessionStore["conversations"]["latestEventSeq"];
  onChange?: (previousEventSeq: number) => void;
  logger?: StructuredLogger;
  review?: PermissionApprovalReviewHook;
}

/**
 * 基于 SessionStore 的权限中介：ask 持久化请求并等待 reply，
 * 支持 session 级审批复用与 parent/child session 权限上溯；变更时触发事件广播。
 */
export class StorePermissionBroker implements PermissionBroker {
  private readonly permissions: StorePermissionBrokerOptions["permissions"];
  private readonly getSession: StorePermissionBrokerOptions["getSession"];
  private readonly eventCursor: StorePermissionBrokerOptions["latestEventSeq"];
  private readonly onChange?: (previousEventSeq: number) => void;
  private readonly logger?: StructuredLogger;
  private readonly controller = new PermissionController();
  private readonly review?: PermissionApprovalReviewHook;
  private readonly currentChecks = new Map<string, () => boolean>();

  constructor(options: StorePermissionBrokerOptions) {
    this.permissions = options.permissions;
    this.getSession = options.getSession;
    this.eventCursor = options.latestEventSeq;
    this.onChange = options.onChange;
    this.logger = options.logger;
    this.review = options.review;
  }

  async ask(input: PermissionAskInput): Promise<AgentPermissionDecision> {
    // BrowserDeveloper is deliberately non-reusable and never routed to a parent
    // session: each inspection must be approved on its own, in its own session.
    const isDeveloper = input.toolName === "BrowserDeveloper";
    const permissionSessionId = isDeveloper
      ? input.sessionId
      : this.resolvePermissionSessionId(input.sessionId);
    const reusable = isDeveloper
      ? undefined
      : this.findSessionApproval(input.sessionId, input.toolName);
    const shouldReview = input.approvalMode === "auto_review" && !reusable
      && input.toolName !== "AskUser" && !isDeveloper;
    const startedAt = Date.now();
    const previousEventSeq = this.latestEventSeq();
    const request = this.permissions.create({
      sessionId: permissionSessionId,
      runId: permissionSessionId === input.sessionId ? input.runId : undefined,
      toolName: input.toolName,
      payload: {
        reason: input.reason,
        input: input.input ?? {},
        ...(permissionSessionId !== input.sessionId ? { childSessionId: input.sessionId } : {}),
        ...(permissionSessionId !== input.sessionId && input.runId ? { childRunId: input.runId } : {}),
        ...(input.traceId ? { traceId: input.traceId } : {}),
        ...(reusable ? { reusedApprovalRequestId: reusable.id } : {}),
        ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
        ...(input.runtimeRevision !== undefined ? { runtimeRevision: input.runtimeRevision } : {}),
        ...(input.inputId ? { inputId: input.inputId } : {}),
        ...(shouldReview ? { approvalReview: { status: "reviewing", startedAt } satisfies ApprovalReviewRecord } : {}),
      },
    });
    if (input.isCurrent) this.currentChecks.set(request.id, input.isCurrent);
    // Register before notifications or the reviewer can synchronously produce a reply.
    const waiting = this.controller.wait({
      requestId: request.id,
      signal: input.signal,
      expire: (reason) => this.expire(request.id, reason),
    });
    void waiting.then(() => this.currentChecks.delete(request.id));
    this.notify(previousEventSeq);
    this.logger?.({
      level: "info",
      event: "permission.requested",
      traceId: input.traceId,
      sessionId: permissionSessionId,
      runId: input.runId,
      requestId: request.id,
      toolName: input.toolName,
    });

    if (this.permissions.get(request.id)?.status !== "pending") return waiting;
    if (!this.isCurrent(request.id)) {
      this.expire(request.id, "Session configuration changed before permission reply");
      return waiting;
    }
    if (reusable) {
      this.reply({ requestId: request.id, status: "approved", decision: "session" });
      this.logger?.({
        level: "info",
        event: "permission.auto_approved",
        traceId: input.traceId,
        sessionId: request.sessionId,
        runId: request.runId,
        requestId: request.id,
        toolName: request.toolName,
      });
      return waiting;
    }
    if (shouldReview) {
      const reviewController = new AbortController();
      void waiting.then(() => reviewController.abort());
      const capturedInput = { ...input, input: structuredClone(request.payload.input as Record<string, unknown>) };
      void this.reviewPending(request, capturedInput, startedAt, reviewController.signal).catch(() => {
        // A storage/broadcast failure must never release the still-pending operation.
        if (this.permissions.get(request.id)?.status === "pending") this.expire(request.id, "Approval review could not be persisted");
      });
    }
    return waiting;
  }

  reply(input: PermissionReplyInput): PermissionRequestRecord {
    const current = this.permissions.get(input.requestId);
    if (!current) throw new Error(`Permission request not found: ${input.requestId}`);
    if (current.status !== "pending") throw new Error(`Permission request already resolved: ${input.requestId}`);
    if (!this.isCurrent(current.id)) {
      this.expire(current.id, "Session configuration changed before permission reply");
      return this.permissions.get(current.id)!;
    }

    const previousEventSeq = this.latestEventSeq();
    // Even if a client submits "session", a developer inspection is only ever
    // approved for this single request.
    const decision =
      current.toolName === "BrowserDeveloper" && input.status === "approved"
        ? "once"
        : input.decision;
    const replied = this.permissions.reply({
      requestId: input.requestId,
      status: input.status,
      decision,
      clientId: input.clientId,
      ...(input.answer !== undefined ? { answer: input.answer } : {}),
    });
    this.notify(previousEventSeq);
    this.controller.resolve(replied.id, this.decisionFromRequest(replied));
    this.logger?.({
      level: "info",
      event: "permission.replied",
      traceId: this.traceIdFromRequest(replied) ?? input.traceId,
      sessionId: replied.sessionId,
      runId: replied.runId,
      requestId: replied.id,
      toolName: replied.toolName,
    });
    return replied;
  }

  getRequest(requestId: string): PermissionRequestRecord | undefined {
    return this.permissions.get(requestId);
  }

  listRequests(input: ListPermissionRequestsInput = {}): PermissionRequestRecord[] {
    return this.permissions.list(input);
  }

  listApprovals(): PermissionRequestRecord[] {
    const latest = new Map<string, PermissionRequestRecord>();
    for (const request of this.permissions.list()) {
      if ((request.status === "approved" && request.decision === "session") || request.decision === "revoked") {
        latest.set(JSON.stringify([request.sessionId, request.toolName]), request);
      }
    }
    return [...latest.values()].filter(request => request.status === "approved" && this.getSession(request.sessionId));
  }

  revokeApproval(requestId: string): PermissionRequestRecord {
    const request = this.permissions.get(requestId);
    if (!request) throw new Error("Permission request not found");
    if (!this.listApprovals().some(approval => approval.id === requestId)) throw new Error("Permission approval is no longer current");
    const previousEventSeq = this.latestEventSeq();
    // Keep the original audit intact. A durable denial marker stops later reuse.
    const marker = this.permissions.create({ sessionId: request.sessionId, toolName: request.toolName,
      payload: { revokedApprovalRequestId: request.id } });
    const revoked = this.permissions.reply({ requestId: marker.id, status: "denied", decision: "revoked" });
    this.notify(previousEventSeq);
    return revoked;
  }

  private findSessionApproval(sessionId: string, toolName: string): PermissionRequestRecord | undefined {
    if (toolName === "AskUser") return undefined;
    for (const candidateId of this.sessionLineage(sessionId)) {
      const approval = this.permissions
        .list({ sessionId: candidateId, toolName })
        .filter((request) => (request.status === "approved" && request.decision === "session") || request.decision === "revoked")
        .at(-1);
      if (approval?.decision === "revoked") return undefined;
      if (approval) return approval;
    }
    return undefined;
  }

  private isCurrent(requestId: string): boolean {
    try { return this.currentChecks.get(requestId)?.() ?? true; } catch { return false; }
  }

  private async reviewPending(request: PermissionRequestRecord, input: PermissionAskInput, startedAt: number, signal: AbortSignal): Promise<void> {
    let outcome: ApprovalReviewOutcome;
    try {
      const review = input.review ?? this.review;
      outcome = review
        ? await review({ request: structuredClone(request), input, signal })
        : { decision: "ask_user", risk: "unknown", authorization: "missing", reason: "自动审查暂时不可用，需要你确认。", failure: "unavailable" };
    } catch {
      outcome = { decision: "ask_user", risk: "unknown", authorization: "missing", reason: "自动审查暂时不可用，需要你确认。", failure: "unavailable" };
    }
    if (this.permissions.get(request.id)?.status !== "pending") return;
    if (input.signal?.aborted || !this.isCurrent(request.id)) {
      this.expire(request.id, "Approval review interrupted or session configuration changed");
      return;
    }
    // The hook is a host integration boundary; reject malformed results here too.
    if (!outcome || !["approve", "ask_user", "deny"].includes(outcome.decision)
      || !["low", "medium", "high", "unknown"].includes(outcome.risk)
      || !["explicit", "task_implied", "missing"].includes(outcome.authorization)
      || typeof outcome.reason !== "string" || !outcome.reason.trim() || outcome.reason.length > 1000) {
      outcome = { decision: "ask_user", risk: "unknown", authorization: "missing", reason: "自动审查结果无效，需要你确认。", failure: "invalid_response" };
    }
    if (outcome.decision === "approve" && (outcome.failure || outcome.risk === "unknown"
      || outcome.authorization === "missing" || (outcome.risk === "high" && outcome.authorization !== "explicit"))) {
      outcome = { ...outcome, decision: "ask_user" };
    }
    const { decision, risk, authorization, reason } = outcome;
    const status: ApprovalReviewRecord["status"] = outcome.failure === "timeout" ? "timed_out"
      : decision === "approve" ? "approved" : decision === "deny" ? "denied" : "ask_user";
    const previousEventSeq = this.latestEventSeq();
    this.permissions.updatePayload(request.id, {
      approvalReview: { status, startedAt, completedAt: Date.now(), reason,
        result: { decision, risk, authorization, reason } } satisfies ApprovalReviewRecord,
    });
    this.notify(previousEventSeq);
    // A notification can deliver a human reply, cancellation, or mode switch.
    if (this.permissions.get(request.id)?.status !== "pending") return;
    if (!this.isCurrent(request.id)) {
      this.expire(request.id, "Session configuration changed before permission reply");
      return;
    }
    if (decision === "approve" || decision === "deny") {
      this.reply({ requestId: request.id, status: decision === "approve" ? "approved" : "denied", decision: "once" });
    }
  }

  private resolvePermissionSessionId(sessionId: string): string {
    return this.sessionLineage(sessionId).at(-1) ?? sessionId;
  }

  private sessionLineage(sessionId: string): string[] {
    const lineage: string[] = [];
    const seen = new Set<string>();
    const storage = getSessionStorage(this.getSession(sessionId));
    let currentId: string | undefined = sessionId;
    while (currentId && !seen.has(currentId)) {
      const session = this.getSession(currentId);
      // 正式与临时会话只共享分叉上下文，不共享审批。
      if (getSessionStorage(session) !== storage) break;
      seen.add(currentId);
      lineage.push(currentId);
      currentId = session?.parentId;
    }
    return lineage;
  }

  private expire(requestId: string, reason: string): void {
    const current = this.permissions.get(requestId);
    if (!current || current.status !== "pending") return;
    const previousEventSeq = this.latestEventSeq();
    const expired = this.permissions.reply({
      requestId,
      status: "expired",
      decision: reason,
    });
    this.notify(previousEventSeq);
    this.controller.resolve(expired.id, this.decisionFromRequest(expired, reason));
    this.logger?.({
      level: "warn",
      event: "permission.expired",
      traceId: this.traceIdFromRequest(expired),
      sessionId: expired.sessionId,
      runId: expired.runId,
      requestId: expired.id,
      toolName: expired.toolName,
      error: reason,
    });
  }

  private decisionFromRequest(request: PermissionRequestRecord, reason?: string): AgentPermissionDecision {
    if (request.status === "approved" || request.status === "denied") {
      return {
        status: request.status,
        ...(request.decision === "once" || request.decision === "session" ? { decision: request.decision } : {}),
        ...(typeof request.payload.answer === "string" ? { answer: request.payload.answer } : {}),
      };
    }
    return {
      status: "expired",
      reason: reason ?? (typeof request.decision === "string" ? request.decision : undefined),
    };
  }

  private traceIdFromRequest(request: PermissionRequestRecord): string | undefined {
    const traceId = request.payload.traceId;
    return typeof traceId === "string" ? traceId : undefined;
  }

  private latestEventSeq(): number {
    return this.eventCursor();
  }

  private notify(previousEventSeq: number): void {
    this.onChange?.(previousEventSeq);
  }
}
