import type { PermissionRequestRecord, PermissionStatus } from "@openharness/protocol";
import type { SessionStore } from "@openharness/services";
import type { AgentPermissionDecision } from "@openharness/core";
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
}

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
  permissions: Pick<SessionStore["permissions"], "create" | "reply" | "expirePending" | "get" | "list">;
  getSession: SessionStore["sessions"]["get"];
  latestEventSeq: SessionStore["conversations"]["latestEventSeq"];
  onChange?: (previousEventSeq: number) => void;
  logger?: StructuredLogger;
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

  constructor(options: StorePermissionBrokerOptions) {
    this.permissions = options.permissions;
    this.getSession = options.getSession;
    this.eventCursor = options.latestEventSeq;
    this.onChange = options.onChange;
    this.logger = options.logger;
  }

  async ask(input: PermissionAskInput): Promise<AgentPermissionDecision> {
    const permissionSessionId = this.resolvePermissionSessionId(input.sessionId);
    const reusable = this.findSessionApproval(input.sessionId, input.toolName);
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
      },
    });
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

    if (reusable) {
      const beforeReply = this.latestEventSeq();
      const replied = this.permissions.reply({
        requestId: request.id,
        status: "approved",
        decision: "session",
      });
      this.notify(beforeReply);
      this.logger?.({
        level: "info",
        event: "permission.auto_approved",
        traceId: input.traceId,
        sessionId: request.sessionId,
        runId: request.runId,
        requestId: request.id,
        toolName: request.toolName,
      });
      return this.decisionFromRequest(replied);
    }

    const decision = await this.controller.wait({
      requestId: request.id,
      signal: input.signal,
      expire: (reason) => this.expire(request.id, reason),
    });
    return decision;
  }

  reply(input: PermissionReplyInput): PermissionRequestRecord {
    const current = this.permissions.get(input.requestId);
    if (!current) throw new Error(`Permission request not found: ${input.requestId}`);
    if (current.status !== "pending") throw new Error(`Permission request already resolved: ${input.requestId}`);

    const previousEventSeq = this.latestEventSeq();
    const replied = this.permissions.reply({
      requestId: input.requestId,
      status: input.status,
      decision: input.decision,
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

  private findSessionApproval(sessionId: string, toolName: string): PermissionRequestRecord | undefined {
    if (toolName === "AskUser") return undefined;
    for (const candidateId of this.sessionLineage(sessionId)) {
      const approval = this.permissions
        .list({ sessionId: candidateId, toolName, status: "approved" })
        .filter((request) => request.decision === "session")
        .at(-1);
      if (approval) return approval;
    }
    return undefined;
  }

  private resolvePermissionSessionId(sessionId: string): string {
    return this.sessionLineage(sessionId).at(-1) ?? sessionId;
  }

  private sessionLineage(sessionId: string): string[] {
    const lineage: string[] = [];
    const seen = new Set<string>();
    let currentId: string | undefined = sessionId;
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      lineage.push(currentId);
      currentId = this.getSession(currentId)?.parentId;
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
