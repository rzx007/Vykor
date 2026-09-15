import type { SessionMessagePartRecord, SessionMessageRecord } from "@openharness/protocol";
import type { SessionStore } from "@openharness/services";
import type { AgentRememberResult } from "@openharness/agent-runtime";
import { updateRulesFromSession, type SessionMessageLike } from "@openharness/personalization";

import { writeSessionExport, type SessionExportFormat } from "../../session/export-session.js";
import { rewindTranscript } from "../../session/rewind.js";
import type { SessionRunEngine } from "./session-run-engine.js";
import type { SessionEventPublisher } from "./session-event-publisher.js";
import type { AgentPool } from "../agent/agent-pool.js";
import type { LiveChildAgentDirectory } from "../agent/live-child-agent-directory.js";
import {
  DaemonOperationUnavailableError,
  type DaemonOperationGate,
  type DaemonOperationLease,
} from "../control/daemon-operation-gate.js";
import { agentMessagesToTranscript } from "../agent/agent-transcript.js";
import { estimateCostUsd } from "../../shared/usage.js";
import { ApplicationError } from "../../shared/application-error.js";
import type { ContextUsageCache } from "../context-usage-cache.js";
import type { SessionContextUsageAgent } from "../assemble-session-context-usage.js";

export class SessionMaintenanceError extends ApplicationError {
  constructor(status: 400 | 404 | 409 | 501, message: string) {
    super(status, message);
    this.name = "SessionMaintenanceError";
  }
}

export interface SessionMaintenanceServiceContext {
  data: SessionStore;
  runEngine: Pick<SessionRunEngine, "hasActiveRunsForCwd" | "hasWork">;
  agentPool: AgentPool;
  liveChildren: Pick<LiveChildAgentDirectory, "has">;
  operationGate: Pick<DaemonOperationGate, "enter" | "tryEnterBarrier">;
  events: Pick<SessionEventPublisher, "checkpoint" | "publishSince">;
  personalizationUpdater?: (messages: SessionMessageLike[]) => number;
  contextUsageCache?: Pick<ContextUsageCache, "invalidate">;
  refreshContextUsage?: (sessionId: string, agent: SessionContextUsageAgent) => Promise<void>;
}

/**
 * Session 维护用例：MCP/usage 检查、compact、rewind、export、remember 等。
 * 通常要求无 active/queued run；会 warm runtime 并在变更 transcript 后必要时关闭 runtime。
 */
export class SessionMaintenanceService {
  constructor(private readonly context: SessionMaintenanceServiceContext) {}

  async listMcpServers(sessionId: string): Promise<unknown[]> {
    const session = this.requireSession(sessionId);
    this.rejectLiveChild(sessionId);
    this.requireRuntime();
    const lease = this.enterSessionOperation(session);
    try {
      return (await this.context.agentPool.acquireSession(sessionId)).inspect().mcpServers;
    } finally {
      lease.release();
    }
  }

  async getUsage(sessionId: string): Promise<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    messageCount: number;
    estimatedCost: string;
  }> {
    const session = this.requireSession(sessionId);
    this.rejectLiveChild(sessionId);
    this.requireRuntime();
    const lease = this.enterSessionOperation(session);
    try {
      const agent = await this.context.agentPool.acquireSession(sessionId);
      const usage = agent.getUsage();
      return {
        model: session.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: usage.cacheCreationTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        messageCount: agent.getHistory().length,
        estimatedCost: estimateCostUsd(session.model, usage.inputTokens, usage.outputTokens),
      };
    } finally {
      lease.release();
    }
  }

  async exportSession(
    sessionId: string,
    input: { format: SessionExportFormat; filename?: string },
  ): ReturnType<typeof writeSessionExport> {
    const session = this.requireSession(sessionId);
    return await writeSessionExport({
      session,
      inputs: this.context.data.listInputs(sessionId),
      messages: this.context.data.listMessages(sessionId),
      parts: this.context.data.listMessageParts(sessionId),
      format: input.format,
      filename: input.filename,
    });
  }

  async compact(sessionId: string): Promise<{
    messageCount: number;
    messages: ReturnType<SessionStore["replaceTranscript"]>["messages"];
    parts: ReturnType<SessionStore["replaceTranscript"]>["parts"];
  }> {
    const session = this.requireSession(sessionId);
    this.rejectLiveChild(sessionId);
    this.requireRuntime();
    const lease = this.acquireSessionBarrier(
      session.id,
      session.cwd,
      "压缩上下文",
      "Cannot compact while a run is active",
    );
    try {
      const agent = await this.context.agentPool.acquireSession(sessionId);
      const before = this.context.events.checkpoint();
      this.appendCompactionPresentation(sessionId, "started");
      let compacted: Awaited<ReturnType<typeof agent.compact>>;
      try {
        compacted = await agent.compact();
      } catch (error) {
        this.appendCompactionPresentation(sessionId, "failed");
        this.context.events.publishSince(before);
        throw error;
      }
      const replaced = this.context.data.replaceTranscript({
        sessionId,
        messages: agentMessagesToTranscript(compacted.history),
      });
      this.appendCompactionPresentation(sessionId, "completed");
      this.context.events.publishSince(before);
      this.context.contextUsageCache?.invalidate(sessionId);
      try {
        await this.context.refreshContextUsage?.(sessionId, agent);
      } catch {
        // Best-effort refresh; invalidate already dropped the stale snapshot.
      }
      return {
        messageCount: compacted.afterMessageCount,
        messages: replaced.messages,
        parts: replaced.parts,
      };
    } finally {
      lease.release();
    }
  }

  private appendCompactionPresentation(
    sessionId: string,
    phase: "started" | "completed" | "failed",
  ): void {
    const message = this.context.data.createMessage({
      sessionId,
      role: "system",
      metadata: { presentation: { kind: "context_compaction", phase } },
    });
    this.context.data.upsertMessagePart({
      sessionId,
      messageId: message.id,
      type: "text",
      status: "completed",
      text:
        phase === "started"
          ? "正在压缩上下文"
          : phase === "completed"
            ? "已压缩上下文"
            : "上下文压缩失败",
    });
  }

  async rewind(
    sessionId: string,
    count: number,
  ): Promise<{
    turns: number;
    removed: number;
    messages: ReturnType<SessionStore["replaceTranscript"]>["messages"];
    parts: ReturnType<SessionStore["replaceTranscript"]>["parts"];
  }> {
    const session = this.requireSession(sessionId);
    this.rejectLiveChild(sessionId);
    const lease = this.acquireSessionBarrier(
      session.id,
      session.cwd,
      "回退会话",
      "Cannot rewind while a run is active",
    );
    try {
      const rewound = rewindTranscript(
        this.context.data.listMessages(sessionId),
        this.context.data.listMessageParts(sessionId),
        count,
      );
      if (rewound.removed === 0) {
        throw new SessionMaintenanceError(400, "No messages to rewind");
      }
      const before = this.context.events.checkpoint();
      const replaced = this.context.data.replaceTranscript({
        sessionId,
        messages: rewound.kept,
      });
      await this.context.agentPool.close(sessionId);
      this.context.events.publishSince(before);
      return {
        turns: rewound.turns,
        removed: rewound.removed,
        messages: replaced.messages,
        parts: replaced.parts,
      };
    } finally {
      lease.release();
    }
  }

  async remember(sessionId: string): Promise<AgentRememberResult> {
    const session = this.requireSession(sessionId);
    this.rejectLiveChild(sessionId);
    this.requireRuntime();
    const lease = this.context.operationGate.tryEnterBarrier(
      { kind: "cwd", cwd: session.cwd },
      () =>
        !this.context.runEngine.hasActiveRunsForCwd(session.cwd) &&
        !this.context.agentPool.hasActiveWorkForCwd(session.cwd),
      maintenanceInfo("更新会话记忆"),
    );
    if (!lease) {
      throw new SessionMaintenanceError(
        409,
        "Cannot remember while session runs are active for this cwd",
      );
    }
    try {
      const agent = await this.context.agentPool.acquireSession(sessionId);
      const result = await agent.remember();
      this.updateLocalEnvironmentRules(sessionId);
      await this.context.agentPool.closeForCwd(session.cwd);
      return result;
    } finally {
      lease.release();
    }
  }

  private requireSession(sessionId: string): NonNullable<ReturnType<SessionStore["getSession"]>> {
    const session = this.context.data.getSession(sessionId);
    if (!session) throw new SessionMaintenanceError(404, "Session not found");
    return session;
  }

  private requireRuntime(): void {
    if (!this.context.agentPool.configured) {
      throw new SessionMaintenanceError(501, "Agent runtime is not configured");
    }
  }

  private rejectLiveChild(sessionId: string): void {
    if (this.context.liveChildren.has(sessionId)) {
      throw new SessionMaintenanceError(
        409,
        "Cannot mutate or inspect a child runtime while it is live in its parent agent",
      );
    }
  }

  private acquireSessionBarrier(
    sessionId: string,
    cwd: string,
    operationName: string,
    message: string,
  ): DaemonOperationLease {
    const lease = this.context.operationGate.tryEnterBarrier(
      { kind: "session", sessionId, cwd },
      () =>
        !this.context.runEngine.hasWork(sessionId) &&
        !this.context.agentPool.hasActiveWorkForSession(sessionId),
      maintenanceInfo(operationName),
    );
    if (!lease) throw new SessionMaintenanceError(409, message);
    return lease;
  }

  private enterSessionOperation(
    session: Pick<NonNullable<ReturnType<SessionStore["getSession"]>>, "id" | "cwd">,
  ): DaemonOperationLease {
    try {
      return this.context.operationGate.enter({
        sessionId: session.id,
        cwd: session.cwd,
      });
    } catch (error) {
      if (error instanceof DaemonOperationUnavailableError) {
        throw new SessionMaintenanceError(409, error.message);
      }
      throw error;
    }
  }

  private updateLocalEnvironmentRules(sessionId: string): void {
    try {
      const messages = transcriptToPersonalizationMessages(
        this.context.data.listMessages(sessionId),
        this.context.data.listMessageParts(sessionId),
      );
      const updater = this.context.personalizationUpdater ?? updateRulesFromSession;
      updater(messages);
    } catch {
      // Local personalization is best-effort and must not block the remember flow.
    }
  }
}

function maintenanceInfo(operationName: string) {
  return { operationId: randomUUID(), operationName, startedAt: Date.now() };
}

function transcriptToPersonalizationMessages(
  messages: SessionMessageRecord[],
  parts: SessionMessagePartRecord[],
): SessionMessageLike[] {
  const partsByMessage = new Map<string, SessionMessagePartRecord[]>();
  for (const part of parts) {
    const list = partsByMessage.get(part.messageId) ?? [];
    list.push(part);
    partsByMessage.set(part.messageId, list);
  }

  return [...messages]
    .sort((a, b) => a.seq - b.seq)
    .map((message) => {
      const content = (partsByMessage.get(message.id) ?? [])
        .sort((a, b) => a.seq - b.seq)
        .map((part) => part.text)
        .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
        .join("\n");
      return { role: message.role, content };
    })
    .filter((message) => message.content.length > 0);
}
import { randomUUID } from "node:crypto";
