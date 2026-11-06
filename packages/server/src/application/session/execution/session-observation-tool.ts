import type { AgentRunScope, ToolDefinition, ToolResult } from "@vykor/agent-contracts";
import type { PermissionRequestRecord, RunStatus, SessionEventRecord } from "@vykor/domain-contracts/sessions";
import type { SessionStore } from "@vykor/services";
import type { ApplicationEventService } from "../../events/application-event-service.js";
import { isRecord } from "../../support.js";
import {
  isObservableSession,
  parseSessionObservationTarget,
  readSessionObservationGrant,
  type SessionObservationGrant,
} from "./session-observation-grant.js";

interface SessionObservationToolOptions {
  store: Pick<SessionStore, "channels" | "conversations" | "permissions" | "runs" | "sessions">;
  events: Pick<ApplicationEventService, "subscribe">;
  assertApplicationOwner(): void;
  accepting(): boolean;
}

type ObserverIdentity = Pick<AgentRunScope, "sessionId" | "runId" | "inputId">;
type PendingCategory = "approval" | "question";
interface ObservationSnapshot {
  targetSessionId: string;
  targetRunId: string | null;
  status: RunStatus | "idle";
  updatedAt: number;
  pending: PendingCategory[];
}

const MAX_WAIT_MS = 30_000;
const TARGET_CHANGE_EVENTS = new Set([
  "session.created",
  "session.updated",
  "session.closing",
  "session.archived",
  "session.transcript.replaced",
  "session.run.created",
  "session.run.updated",
  "permission.asked",
  "permission.replied",
]);

export function createSessionObservationTool(
  options: SessionObservationToolOptions,
  observer: ObserverIdentity,
  grant: SessionObservationGrant,
): ToolDefinition {
  const { sessionId, runId, inputId } = observer;
  const { targetSessionId, targetRunId, afterSeq } = grant;
  const store = options.store;

  function snapshot(scope: AgentRunScope, signal: AbortSignal): ObservationSnapshot | undefined {
    try {
      options.assertApplicationOwner();
      if (!options.accepting() || signal.aborted) return;
      const source = store.sessions.get(sessionId);
      const run = store.runs.getRun(runId);
      if (!isObservableSession(source) || source.id !== sessionId || scope.agentId !== sessionId || scope.cwd !== source.cwd
        || store.channels.hasConversationSession(sessionId)
        || !run || run.sessionId !== sessionId || run.inputId !== inputId || !isActive(run.status)) return;
      const current = readSessionObservationGrant(run);
      if (current?.targetSessionId !== targetSessionId || current.targetRunId !== targetRunId || current.afterSeq !== afterSeq) return;
      const input = store.conversations.getInput(inputId);
      if (input?.sessionId !== sessionId || input.delivery !== "queue"
        || parseSessionObservationTarget(input.items[0]) !== targetSessionId) return;

      const target = store.sessions.get(targetSessionId);
      if (sessionId === targetSessionId || !isObservableSession(target) || target.id !== targetSessionId
        || store.channels.hasConversationSession(targetSessionId)
        || store.conversations.wasObservationTargetCreatedAfter(targetSessionId, targetRunId, afterSeq)) return;
      if (targetRunId === null) {
        return { targetSessionId, targetRunId, status: "idle", updatedAt: target.createdAt, pending: [] };
      }
      const targetRun = store.runs.getRun(targetRunId);
      if (!targetRun || targetRun.sessionId !== targetSessionId) return;
      const pending = new Set<PendingCategory>();
      if (isActive(targetRun.status)) {
        for (const request of store.permissions.list({ sessionId: targetSessionId, status: "pending" })) {
          if (request.runId !== targetRunId || !needsPerson(request)) continue;
          const payload = request.payload.input;
          const isQuestion = request.toolName === "AskUser" && isRecord(payload) && payload.kind === "question";
          pending.add(isQuestion ? "question" : "approval");
        }
      }
      return { targetSessionId, targetRunId, status: targetRun.status, updatedAt: targetRun.updatedAt, pending: [...pending].sort() };
    } catch {
      // Store failures and malformed persisted grants must never disclose target data.
      return undefined;
    }
  }

  function canWake(event: SessionEventRecord): boolean {
    if (event.type === "session.deleted") {
      const deleted = event.payload.sessionIds;
      return Array.isArray(deleted) && (deleted.includes(targetSessionId) || deleted.includes(sessionId));
    }
    return event.sessionId === targetSessionId && TARGET_CHANGE_EVENTS.has(event.type);
  }

  return {
    name: "SessionObserve",
    description: "Read the progress of the target Run authorized by the user's observe-session instruction. With timeoutMs, wait briefly for completion or a human approval or question. Omit timeoutMs for a current snapshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        timeoutMs: { type: "integer", minimum: 0, default: 0, description: "Maximum wait in milliseconds, capped at 30000 and the tool deadline." },
      },
    },
    execution: { domain: "control_plane", supportedEnvironments: ["local", "wsl"] },
    safeToRetry: true,
    async execute(input, context) {
      const timeoutMs = input?.timeoutMs ?? 0;
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "timeoutMs")
        || input.timeoutMs === null || typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
        return failure("SessionObserve accepts only timeoutMs as a non-negative integer.");
      }
      const scope = context.agent?.scope;
      if (!scope || scope.sessionId !== sessionId || scope.runId !== runId || scope.inputId !== inputId) return unavailable();
      const signal = AbortSignal.any([scope.signal, ...[context.abortSignal, context.runAbortSignal].filter(s => s !== undefined)]);
      if (signal.aborted) return failure("SessionObserve was cancelled.");

      // Keep the cursor before the first synchronous snapshot so subscription replay covers the gap.
      const after = store.conversations.latestEventSeq();
      const read = () => snapshot(scope, signal);
      const initial = read();
      if (!initial) return unavailable();
      if (timeoutMs === 0 || !stillWaiting(initial)) return success(initial, false);

      const now = Date.now();
      const remaining = Math.max(0, (context.deadlineAt ?? Infinity) - now);
      // Leave time to re-read records and deliver the result before the tool is stopped.
      const waitMs = Math.min(MAX_WAIT_MS, timeoutMs, remaining - Math.min(1_000, remaining * 0.2));
      if (waitMs <= 0) return success(initial, true);

      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), waitMs);
      try {
        const subscription = options.events.subscribe({
          after,
          sessionId: targetSessionId,
          signal: AbortSignal.any([signal, deadline.signal]),
        });
        for await (const event of subscription.stream) {
          if (signal.aborted || Date.now() >= now + waitMs) {
            deadline.abort();
            break;
          }
          if (!canWake(event)) continue;
          const latest = read();
          if (!latest) return unavailable();
          if (!stillWaiting(latest)) return success(latest, false);
        }
      } catch {
        if (!signal.aborted && !deadline.signal.aborted) return retryable();
      } finally {
        clearTimeout(timer);
      }
      if (signal.aborted) return failure("SessionObserve was cancelled.");
      if (!deadline.signal.aborted) return retryable();
      const latest = read();
      return latest ? success(latest, stillWaiting(latest)) : unavailable();
    },
  };
}

function needsPerson(request: PermissionRequestRecord): boolean {
  const { childSessionId, childRunId, reusedApprovalRequestId, approvalReview } = request.payload;
  if (childSessionId || childRunId || reusedApprovalRequestId) return false;
  const reviewStatus = isRecord(approvalReview) ? approvalReview.status : undefined;
  return reviewStatus !== "reviewing" && reviewStatus !== "approved" && reviewStatus !== "denied";
}

function isActive(status: ObservationSnapshot["status"]): boolean {
  return status === "pending" || status === "running";
}

function stillWaiting(snapshot: ObservationSnapshot): boolean {
  return isActive(snapshot.status) && snapshot.pending.length === 0;
}

function success(snapshot: ObservationSnapshot, timedOut: boolean): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ...snapshot, timedOut }) }] };
}

function failure(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function unavailable(): ToolResult {
  return failure("SessionObserve is unavailable for this Run or its authorized target.");
}

function retryable(): ToolResult {
  return failure("The SessionObserve event stream is unavailable. Retry the observation.");
}
