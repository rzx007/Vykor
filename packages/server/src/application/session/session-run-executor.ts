import { readSessionRuntimeConfig, type SessionRecord } from "@openharness/protocol";
import type { ProviderInputCapabilities } from "@openharness/api";
import { PluginPreparationError } from "@openharness/agent-runtime";
import type { ContentBlock, ModelInputCapabilities } from "@openharness/core";
import type { GoalOperations, SessionStore } from "@openharness/services";

import type { ObservabilityEvent } from "../../shared/observability.js";
import { RunInterruptedError, type SessionRunWorkContext } from "../../runtime/run-coordinator.js";
import type { AgentPool } from "../agent/agent-pool.js";
import type { SessionPostRunMaintenance } from "./session-post-run-maintenance.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { SessionTranscriptProjection } from "./transcript-projection.js";
import type {
  AttachmentRoutingDecision,
  AttachmentRoutingError,
  NativeAttachmentRouteResult,
  RouteAttachmentBatchInput,
} from "../attachment-routing/attachment-routing-types.js";
import type { SessionAttachmentResources } from "../attachment-resource/session-attachment-resources.js";
import {
  applyMaterializedSessionInput,
  materializeSessionInput,
  type SessionInputSkillCatalog,
} from "./session-input-materializer.js";
import { conversationContextCatalog } from "./session-conversation-context.js";
import type { ContextUsageCache } from "../context-usage-cache.js";
import type { SessionContextUsageAgent } from "../assemble-session-context-usage.js";

const ATTACHMENT_LEASE_TTL_MS = 2 * 60 * 1_000;
const ATTACHMENT_LEASE_RENEW_INTERVAL_MS = 30 * 1_000;

export interface SessionRunExecutorContext {
  store: SessionStore;
  goals: Pick<GoalOperations, "getGoal">;
  agentPool: Pick<
    AgentPool,
    "configured" | "acquireSession" | "close" | "closeIfStale"
  >;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  transcriptProjection: Pick<
    SessionTranscriptProjection,
    "finalizeRunParts" | "projectAttachmentTransformations"
  >;
  resolveCapabilities?(session: SessionRecord): Promise<{
    modelCapabilities: ModelInputCapabilities;
    providerCapabilities: ProviderInputCapabilities;
  }>;
  routeAttachments?(
    input: RouteAttachmentBatchInput,
  ): Promise<NativeAttachmentRouteResult>;
  traceIdForRun(runId: string): string;
  log(event: ObservabilityEvent): void;
  postRunMaintenance?: Pick<SessionPostRunMaintenance, "run">;
  attachmentResources?: Pick<SessionAttachmentResources, "materializeRun">;
  attachmentOcrAvailable?: boolean;
  /** Invalidate / refresh session context-usage cache on run terminal states. */
  contextUsageCache?: Pick<ContextUsageCache, "invalidate">;
  refreshContextUsage?: (
    sessionId: string,
    agent: SessionContextUsageAgent,
  ) => Promise<void>;
  /** Re-read the cwd catalog before executing renderer-supplied Skill paths. */
  resolveSkillCatalog?(session: SessionRecord): Promise<SessionInputSkillCatalog>;
}

export interface ExecuteSessionRunInput {
  sessionId: string;
  inputId: string;
  runId: string;
}

/**
 * 把一条已经入队的 durable run 交给内存里的 Agent 真正执行。
 *
 * 调用方是 SessionRunCoordinator：每个 session 一条车道，轮到这条 run 时才会进来。
 * HTTP admitPrompt 此时已经返回 202；这里的 await 只挡住车道，不挡住客户端。
 *
 * 正常终态（completed / failed / interrupted）由 Agent 事件经 DaemonAgentEventProjector
 * 写进 SessionStore。本类成功路径不再 updateRun；catch 只覆盖「agent 还没发出终态事件」
 * 的失败（例如 acquireSession 抛错），避免 run 永远停在 pending。
 */
export class SessionRunExecutor {
  constructor(private readonly context: SessionRunExecutorContext) {}

  async execute(input: ExecuteSessionRunInput, workContext: SessionRunWorkContext): Promise<void> {
    // 测试或未接线的 daemon：store 里可以有 run，但没有可执行的 agent。
    if (!this.context.agentPool.configured) return;
    const { sessionId, inputId, runId } = input;
    let agentTouched = false;
    let cleanupAttachmentResources: (() => Promise<void>) | undefined;
    let cleanupAttachmentLease: (() => void) | undefined;
    try {
      const session = this.context.store.getSession(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      const admitted = this.context.store.getInput(inputId);
      if (!admitted) throw new Error(`Session input not found: ${inputId}`);
      const storedRun = typeof this.context.store.getRun === "function"
        ? this.context.store.getRun(runId)
        : undefined;
      const hasStructuredContext = admitted.items.some((item) => item.type === "skill" || item.type === "context" || (item.type === "capability" && item.kind === "plugin_agent"));
      const hasExplicitSkills = admitted.items.some((item) => item.type === "skill");

      if (admitted.attachments.length > 0) {
        const acquiredAt = Date.now();
        this.context.store.acquireAttachmentLeases({
          assetIds: admitted.attachments.map((reference) => reference.assetId),
          ownerKind: "session_run",
          ownerId: runId,
          timestamp: acquiredAt,
          expiresAt: acquiredAt + ATTACHMENT_LEASE_TTL_MS,
        });
        const renewTimer = setInterval(() => {
          const timestamp = Date.now();
          try {
            this.context.store.renewAttachmentLeases({
              ownerKind: "session_run",
              ownerId: runId,
              timestamp,
              expiresAt: timestamp + ATTACHMENT_LEASE_TTL_MS,
            });
          } catch (error) {
            this.context.log({
              level: "error",
              event: "attachment.lease.renew_failed",
              traceId: this.context.traceIdForRun(runId),
              sessionId,
              runId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }, ATTACHMENT_LEASE_RENEW_INTERVAL_MS);
        renewTimer.unref?.();
        cleanupAttachmentLease = () => {
          clearInterval(renewTimer);
          this.context.store.releaseAttachmentLeases("session_run", runId);
        };
      }

      // 先拿到实际 Agent，路由才能看见 allow/deny 过滤后的工具和真实宿主能力。
      agentTouched = true;
      const agent = await this.context.agentPool.acquireSession(sessionId);
      agent.setModel(readSessionRuntimeConfig(session).model);
      const pluginId = typeof storedRun?.metadata?.pluginId === "string" ? storedRun.metadata.pluginId : undefined;
      const capabilityView = agent.createRunCapabilityView?.(pluginId);
      if (pluginId && !capabilityView) throw new Error("Plugin capability view is unavailable");
      const materialized = hasStructuredContext
        ? materializeSessionInput(
            admitted.items,
            hasExplicitSkills
              ? await resolveSkillCatalog(session, this.context.resolveSkillCatalog)
              : { resolvePath: () => undefined },
            conversationContextCatalog(this.context.store, sessionId),
            capabilityView,
          )
        : undefined;

      let submittedContent: string | ContentBlock[] = materialized?.text ?? admitted.content;
      if (admitted.attachments.length > 0) {
        if (!this.context.resolveCapabilities || !this.context.routeAttachments) {
          throw new Error("attachment routing is not configured");
        }
        const capabilities = await this.context.resolveCapabilities(session);
        const inspection = agent.inspect();
        const routed = await this.context.routeAttachments({
          text: materialized?.text ?? admitted.content,
          attachments: admitted.attachments,
          ...capabilities,
          availableTools: inspection.tools.map((tool) => tool.name),
          attachmentOcrAvailable: this.context.attachmentOcrAvailable === true,
          signal: workContext.signal,
        });
        submittedContent = routed.content;
        cleanupAttachmentResources = await this.context.attachmentResources?.materializeRun({
          sessionId,
          runId,
          decisions: routed.decisions,
        });
        const beforeAttachmentProjection = this.context.events.checkpoint();
        this.context.store.transaction(() => {
          this.context.transcriptProjection.projectAttachmentTransformations({
            sessionId,
            inputId,
            runId,
            input: admitted,
            decisions: routed.decisions,
            status: "completed",
          });
          this.context.store.updateRun(runId, {
            metadata: {
              attachmentRouting: {
                status: "completed",
                decisions: routed.decisions,
              },
            },
          });
        });
        this.context.events.publishSince(beforeAttachmentProjection);
      }

      if (materialized) {
        submittedContent = applyMaterializedSessionInput(
          submittedContent,
          materialized,
        );
      }
      const goalId = typeof storedRun?.metadata?.goalId === "string" ? storedRun.metadata.goalId : undefined;
      const goalRevision = typeof storedRun?.metadata?.goalRevision === "number" ? storedRun.metadata.goalRevision : undefined;
      let goalBinding: { goalId: string; revision: number; objective: string } | undefined;
      if (goalId && goalRevision !== undefined) {
        const goal = this.context.goals.getGoal(goalId);
        if (!goal || goal.sessionId !== sessionId || goal.revision !== goalRevision || goal.status !== "active") {
          throw new Error("session_goal_run_is_stale");
        }
        goalBinding = { goalId: goal.id, revision: goal.revision, objective: goal.objective };
      }

      // 把 store 里已有的 inputId/runId/traceId 传进去，投影层才能把流式事件对上这条 durable run。
      // 不要让 agent 自己再生成一套 id，否则 SSE 里的 run 和 HTTP 回的 run 会对不上。
      const run = agent.submitMessage(submittedContent, {
        ...(capabilityView ? { capabilityView } : {}),
        ...(goalBinding ? { goal: goalBinding } : {}),
        inputItems: admitted.items,
        signal: workContext.signal,
        delivery: admitted.delivery,
        metadata: admitted.metadata,
        ids: {
          inputId,
          runId,
          traceId: this.context.traceIdForRun(runId),
        },
      });

      // 先把活句柄交给 coordinator，排队中的 steer / interrupt 才能打到这次 submitMessage 上。
      // 若在 register 前已经被 abort，coordinator 会立刻 interrupt 这个 handle。
      await workContext.registerHandle(run);

      // 模型回合、工具、JobWait 都在这次 result 里。成功时 projector 已经把 run 标成 completed。
      await run.result;

      // 只在成功走完之后做记忆/个性化/auto-dream。失败路径不跑，避免半截对话被写进长期记忆。
      await this.context.postRunMaintenance?.run(sessionId, runId, agent);

      // Run terminal (success): invalidate then rewrite live usage from the same agent
      // before closeIfStale may drop the warm runtime.
      this.context.contextUsageCache?.invalidate(sessionId);
      try {
        await this.context.refreshContextUsage?.(sessionId, agent);
      } catch (error) {
        this.context.log({
          level: "warn",
          event: "context.usage.refresh_failed",
          traceId: this.context.traceIdForRun(runId),
          sessionId,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Soft settings may have marked this warm agent stale while the run was active.
      await this.context.agentPool.closeIfStale(sessionId);
    } catch (error) {
      // 这次 run 把 session agent 弄脏了（或根本没创建成功）：关掉，下次 acquire 会新建。
      // close 失败不能盖住原始错误；先记日志，再继续结算 run。
      let cleanupError: unknown;
      if (agentTouched) {
        try {
          await this.context.agentPool.close(sessionId);
        } catch (closeError) {
          cleanupError = closeError;
        }
      }
      const current = this.context.store.getRun(runId);
      if (cleanupError) {
        this.context.log({
          level: "error",
          event: "session.agent.cleanup_failed",
          traceId: this.context.traceIdForRun(runId),
          sessionId,
          runId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }

      // projector / interrupt 已经写下终态就不要再改：否则会把 completed 覆盖成 failed。
      if (current && ["completed", "failed", "interrupted"].includes(current.status)) {
        this.context.contextUsageCache?.invalidate(sessionId);
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      const traceId = this.context.traceIdForRun(runId);
      const interrupted = error instanceof RunInterruptedError || workContext.signal.aborted;
      const routingError = attachmentRoutingError(error);
      const before = this.context.events.checkpoint();
      this.context.store.transaction(() => {
        if (routingError) {
          const admitted = this.context.store.getInput(inputId);
          if (admitted) {
            this.context.transcriptProjection.projectAttachmentTransformations({
              sessionId,
              inputId,
              runId,
              input: admitted,
              decisions: routingError.decisions,
              status: "failed",
              errorCode: routingError.code,
            });
          }
        }
        this.context.transcriptProjection.finalizeRunParts(
          sessionId,
          runId,
          interrupted ? "interrupted" : "failed",
        );
        this.context.store.appendEvent({
          type: interrupted ? "session.run.interrupted" : "session.run.error",
          sessionId,
          payload: {
            runId,
            traceId,
            error: message,
            ...(routingError ? { errorKind: routingError.code } : {}),
          },
        });
        if (typeof this.context.store.settleActiveRunAttempts === "function") {
          this.context.store.settleActiveRunAttempts(
            runId,
            interrupted ? "cancelled" : "failed",
            message,
          );
        }
        this.context.store.updateRun(runId, {
          status: interrupted ? "interrupted" : "failed",
          error: message,
          ...(error instanceof PluginPreparationError ? {
            metadata: { ...current?.metadata, pluginPreparation: {
              status: "failed", pluginId: error.pluginId, error: message,
            } },
          } : {}),
          ...(routingError
            ? {
                metadata: {
                  attachmentRouting: {
                    status: "blocked",
                    code: routingError.code,
                    assetIds: routingError.assetIds,
                    decisions: routingError.decisions,
                  },
                },
              }
            : {}),
        });
      });
      this.context.log({
        level: interrupted ? "warn" : "error",
        event: interrupted ? "session.run.interrupted" : "session.run.failed",
        traceId,
        sessionId,
        runId,
        error: message,
      });
      this.context.events.publishSince(before);
      // Failed / interrupted terminal: drop stale usage; next usage() may reassemble.
      this.context.contextUsageCache?.invalidate(sessionId);
    } finally {
      if (cleanupAttachmentResources) {
        try {
          await cleanupAttachmentResources();
        } catch (error) {
          this.context.log({
            level: "error",
            event: "attachment.resources.cleanup_failed",
            traceId: this.context.traceIdForRun(runId),
            sessionId,
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (cleanupAttachmentLease) {
        try {
          cleanupAttachmentLease();
        } catch (error) {
          this.context.log({
            level: "error",
            event: "attachment.lease.release_failed",
            traceId: this.context.traceIdForRun(runId),
            sessionId,
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}

async function resolveSkillCatalog(
  session: SessionRecord,
  resolver: SessionRunExecutorContext["resolveSkillCatalog"],
): Promise<SessionInputSkillCatalog> {
  if (!resolver) {
    throw new Error(
      `session_input_skill_catalog_unavailable: cannot validate skills for ${session.cwd}`,
    );
  }
  return await resolver(session);
}

function attachmentRoutingError(error: unknown): Pick<
  AttachmentRoutingError,
  "code" | "assetIds" | "decisions"
> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Partial<AttachmentRoutingError>;
  if (
    typeof candidate.code !== "string" ||
    !Array.isArray(candidate.assetIds) ||
    !Array.isArray(candidate.decisions)
  ) {
    return undefined;
  }
  return candidate as Pick<
    AttachmentRoutingError,
    "code" | "assetIds" | "decisions"
  >;
}
