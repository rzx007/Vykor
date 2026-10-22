import type {
  WorkflowRunSnapshot,
  WorkflowRunEvent,
  WorkflowRunSummary,
} from "./model.js";

export type WorkflowReadDiagnosticCode =
  "invalid_workflow_snapshot" | "invalid_workflow_event";

/** 读取持久 Workflow 数据时，单条损坏记录对应的安全诊断（不含路径或原始内容）。 */
export interface WorkflowReadDiagnostic {
  code: WorkflowReadDiagnosticCode;
  sourceId: string;
}

export interface WorkflowSnapshotReadResult {
  snapshots: WorkflowRunSnapshot[];
  diagnostics: WorkflowReadDiagnostic[];
}

export interface WorkflowEventReadResult {
  events: WorkflowRunEvent[];
  diagnostics: WorkflowReadDiagnostic[];
}

/** Workflow 持久化入口。具体数据可以放在项目文件、SQLite 或其他宿主存储中。 */
export interface WorkflowRunRepository {
  readonly repositoryKey: string;
  save(snapshot: WorkflowRunSnapshot): void;
  appendEvent(event: WorkflowRunEvent): void;
  loadEvents(runId: string): WorkflowRunEvent[];
  loadEventsWithDiagnostics(runId: string): WorkflowEventReadResult;
  load(runId: string): WorkflowRunSnapshot | undefined;
  list(): WorkflowRunSnapshot[];
  listWithDiagnostics(): WorkflowSnapshotReadResult;
  listSummaries(): WorkflowRunSummary[];
  latest(): WorkflowRunSnapshot | undefined;
  claim(runId: string): {
    ownerId: string;
    generation: number;
    claimedAt: number;
  };
  finish(runId: string, status: WorkflowRunSnapshot["status"]): void;
  waitForChange(
    runId: string,
    after: number,
    options: {
      timeoutMs: number;
      signal?: AbortSignal;
    },
  ): Promise<WorkflowRunSnapshot | undefined>;
}
