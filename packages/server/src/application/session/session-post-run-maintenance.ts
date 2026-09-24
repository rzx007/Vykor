import { getProjectMemoryDir, type Settings } from "@vykor/core";
import type { VykorAgent } from "@vykor/agent-runtime";
import { updateRulesFromSession, type SessionMessageLike } from "@vykor/personalization";
import type { SessionStore } from "@vykor/services";

import type { ObservabilityEvent } from "../../shared/observability.js";
import { isPublicTextPart } from "../../session/transcript-text.js";

export interface SessionPostRunMaintenanceContext {
  data: Pick<SessionStore, "conversations" | "runs" | "sessions" | "goals">;
  getSettings(cwd: string): Promise<Settings | undefined>;
  personalizationUpdater?: (messages: SessionMessageLike[]) => number;
  sessionMemoryWriter?: (cwd: string, messages: SessionMessageLike[], sessionId: string, goal?: string) => void;
  lastConsolidatedAt?: (memoryDir: string) => number;
  autoDream?: (input: {
    cwd: string;
    settings: Settings;
    memoryDir: string;
    currentSessionId: string;
    recentSessionIds: string[];
    model: string;
  }) => Promise<unknown>;
  log(event: ObservabilityEvent): void;
}

/** Best-effort durable-memory maintenance after one root run has completed. */
export class SessionPostRunMaintenance {
  constructor(private readonly context: SessionPostRunMaintenanceContext) {}

  async run(sessionId: string, runId: string, agent: VykorAgent): Promise<void> {
    try {
      await this.runMaintenance(sessionId, runId, agent);
    } catch (error) {
      this.context.log({
        level: "warn",
        event: "session.post_run_maintenance_failed",
        sessionId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runMaintenance(
    sessionId: string,
    runId: string,
    agent: VykorAgent,
  ): Promise<void> {
    const session = this.context.data.sessions.get(sessionId);
    const run = this.context.data.runs.getRun(runId);
    if (!session || run?.status !== "completed") return;

    const messages = transcriptMessages(this.context.data, sessionId);

    await this.bestEffort("session.personalization.extract_failed", sessionId, runId, async () => {
      const update = this.context.personalizationUpdater ?? updateRulesFromSession;
      update(messages);
    });

    const settings = await this.context.getSettings(session.cwd);
    if (!settings || settings.memory?.enabled === false) return;

    if (settings.memory?.sessionMemoryEnabled !== false) {
      await this.bestEffort("session.memory.checkpoint_failed", sessionId, runId, async () => {
        const goalId = run.metadata?.goalId;
        const goal = typeof goalId === "string"
          ? this.context.data.goals.getGoal(goalId)?.objective
          : undefined;
        if (goal) this.context.sessionMemoryWriter?.(session.cwd, messages, sessionId, goal);
        else this.context.sessionMemoryWriter?.(session.cwd, messages, sessionId);
      });
    }

    if (settings.memory?.autoExtractEnabled !== false) {
      await this.bestEffort("session.memory.auto_extract_failed", sessionId, runId, async () => {
        await agent.remember();
      });
    }

    if (settings.memory?.autoDreamEnabled) {
      await this.bestEffort("session.memory.auto_dream_failed", sessionId, runId, async () => {
        const memoryDir = getProjectMemoryDir(session.cwd);
        const lastAtMs = (this.context.lastConsolidatedAt?.(memoryDir) ?? 0) * 1000;
        const recentSessionIds = this.context.data.sessions
          .list({ cwd: session.cwd, includeArchived: true })
          .filter((candidate) => candidate.updatedAt > lastAtMs)
          .map((candidate) => candidate.id);
        await this.context.autoDream?.({
          cwd: session.cwd,
          settings,
          memoryDir,
          currentSessionId: sessionId,
          recentSessionIds,
          model: session.model,
        });
      });
    }
  }

  private async bestEffort(
    event: string,
    sessionId: string,
    runId: string,
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.context.log({
        level: "warn",
        event,
        sessionId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function transcriptMessages(
  store: Pick<SessionStore, "conversations">,
  sessionId: string,
): SessionMessageLike[] {
  return store.conversations.listMessages(sessionId)
    .sort((a, b) => a.seq - b.seq)
    .map((message) => {
      const content = store.conversations.listMessageParts(sessionId, { messageId: message.id })
        .sort((a, b) => a.seq - b.seq)
        .filter(isPublicTextPart)
        .map((part) => part.text ?? (typeof part.output === "string" ? part.output : ""))
        .filter(Boolean)
        .join("\n");
      return { role: message.role, content };
    })
    .filter((message) => message.content.length > 0);
}
