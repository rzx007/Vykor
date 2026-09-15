import { randomUUID } from "node:crypto";
import type { SessionStore } from "@openharness/services";

import type { HookInfo } from "../settings-api.js";
import type { SessionRunEngine } from "../session/session-run-engine.js";
import type { RunControlService } from "../session/run-control-service.js";
import type { AgentPool } from "../agent/agent-pool.js";
import type { DaemonOperationGate, DaemonOperationLease } from "./daemon-operation-gate.js";
import { countByStatus, type OpenHarnessRuntimeSnapshot } from "../support.js";
import { buildRuntimeMetricsSnapshot } from "../../shared/runtime-metrics.js";
import { inspectDurableRun, listProjectionDiagnostics } from "./run-inspector.js";

export interface DaemonControlServiceContext {
  store: SessionStore;
  permissions: Pick<SessionStore["permissions"], "list">;
  workflows: Pick<SessionStore["workflows"], "listRuns">;
  runEngine: Pick<
    SessionRunEngine,
    "activeRunId" | "hasActiveRunsForCwd" | "hasAnyActiveRuns" | "queuedRunIds" | "stopAndDrain"
  >;
  runControl?: Pick<RunControlService, "activeRunId" | "hasActiveRunsForCwd" | "hasAnyActiveRuns" | "queuedRunIds" | "stopAndDrain">;
  agentPool: Pick<
    AgentPool,
    | "configured"
    | "size"
    | "hasActiveWork"
    | "hasActiveWorkForCwd"
    | "acquireSession"
    | "closeAll"
    | "closeForCwd"
    | "invalidateWarmAgents"
  >;
  operationGate: DaemonOperationGate;
  startedAt: number;
  sseClientCount(): number;
}

/**
 * Daemon 控制面：runtime 快照、按 cwd/全局关闭 runtime、是否有活跃 run、
 * hooks 等检查能力；供 /health、settings/plugin 等路由在写配置前做 barrier。
 */
export class DaemonControlService {
  private readonly runControl;

  constructor(private readonly context: DaemonControlServiceContext) {
    this.runControl = context.runControl ?? context.runEngine;
  }

  get runtimeInspectionAvailable(): boolean {
    return this.context.agentPool.configured;
  }

  runtimeSnapshot(): OpenHarnessRuntimeSnapshot {
    const sessions = this.context.store.listSessions({ includeArchived: true });
    const runs = sessions.flatMap((session) => this.context.store.listRuns(session.id));
    const tasks = sessions.flatMap((session) => this.context.store.listSessionTasks(session.id));
    const workflows = this.context.workflows.listRuns();
    const permissions = this.context.permissions.list();
    const projectionSettlements = this.context.store.listProjectionSettlements();
    const attempts =
      typeof this.context.store.listRunAttempts === "function"
        ? runs.flatMap((run) => this.context.store.listRunAttempts(run.id))
        : [];
    const parts =
      typeof this.context.store.listMessageParts === "function"
        ? sessions.flatMap((session) => this.context.store.listMessageParts(session.id))
        : [];
    const activeRunCount = sessions.filter(
      (session) => this.runControl.activeRunId(session.id) !== undefined,
    ).length;
    const queuedRunCount = sessions.reduce(
      (count, session) => count + this.runControl.queuedRunIds(session.id).length,
      0,
    );
    const now = Date.now();
    return {
      startedAt: this.context.startedAt,
      uptimeMs: now - this.context.startedAt,
      sessions: { total: sessions.length, byStatus: countByStatus(sessions) },
      runs: { total: runs.length, byStatus: countByStatus(runs) },
      tasks: { total: tasks.length, byStatus: countByStatus(tasks) },
      workflows: {
        total: workflows.length,
        byStatus: countByStatus(workflows),
      },
      permissions: {
        total: permissions.length,
        byStatus: countByStatus(permissions),
      },
      projectionSettlements: {
        total: projectionSettlements.length,
        pending: projectionSettlements.filter(
          (row) => row.status === "pending" || row.status === "retrying",
        ).length,
        byStatus: countByStatus(projectionSettlements),
      },
      sseClientCount: this.context.sseClientCount(),
      warmAgentCount: this.context.agentPool.size,
      coordinator: { activeRunCount, queuedRunCount },
      metrics: buildRuntimeMetricsSnapshot({
        runs,
        attempts,
        parts,
        tasks,
        permissions,
        settlements: projectionSettlements,
        workflows,
      }),
    };
  }

  inspectRun(runId: string, options: { includeContent?: boolean } = {}) {
    return inspectDurableRun(this.context.store, this.context.permissions, this.context.workflows, runId, options.includeContent === true);
  }

  listProjectionDiagnostics(options: { includeContent?: boolean } = {}) {
    return listProjectionDiagnostics(this.context.store, options.includeContent === true);
  }

  hasAnyActiveRuns(): boolean {
    return this.runControl.hasAnyActiveRuns() || this.context.agentPool.hasActiveWork();
  }

  hasActiveRunsForCwd(cwd: string): boolean {
    return (
      this.runControl.hasActiveRunsForCwd(cwd) ||
      this.context.agentPool.hasActiveWorkForCwd(cwd)
    );
  }

  acquireGlobalMutation(): DaemonOperationLease | undefined {
    return this.context.operationGate.tryEnterBarrier(
      { kind: "global" },
      () => !this.hasAnyActiveRuns(),
      {
        operationId: randomUUID(),
        operationName: "全局运行时维护",
        startedAt: Date.now(),
      },
    );
  }

  acquireCwdMutation(cwd: string): DaemonOperationLease | undefined {
    return this.context.operationGate.tryEnterBarrier(
      { kind: "cwd", cwd },
      () => !this.hasActiveRunsForCwd(cwd),
      {
        operationId: randomUUID(),
        operationName: "工作区运行时维护",
        startedAt: Date.now(),
      },
    );
  }

  async closeAllRuntimes(): Promise<void> {
    await this.context.agentPool.closeAll();
  }

  async closeRuntimesForCwd(cwd: string): Promise<void> {
    await this.context.agentPool.closeForCwd(cwd);
  }

  async invalidateRuntimes(): Promise<void> {
    await this.context.agentPool.invalidateWarmAgents();
  }

  async shutdown(): Promise<void> {
    await this.context.operationGate.beginShutdown();
    const failures: unknown[] = [];
    try {
      await this.runControl.stopAndDrain();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.context.agentPool.closeAll();
    } catch (error) {
      failures.push(error);
    } finally {
      this.context.operationGate.markClosed();
    }
    throwFailures(failures, "Daemon shutdown failed");
  }

  sessionExists(sessionId: string): boolean {
    return this.context.store.getSession(sessionId) !== undefined;
  }

  async inspectRuntimeHooks(sessionId: string): Promise<HookInfo[]> {
    const session = this.context.store.getSession(sessionId);
    if (!session) return [];
    const lease = this.context.operationGate.enter({
      sessionId,
      cwd: session.cwd,
    });
    try {
      const agent = await this.context.agentPool.acquireSession(sessionId);
      return agent.inspect().hooks.map((hook) => ({ ...hook, origin: "runtime" as const }));
    } finally {
      lease.release();
    }
  }
}

function throwFailures(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}
