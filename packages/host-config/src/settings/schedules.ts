export interface AgentScheduledTaskInput {
  name: string;
  prompt: string;
  recurrence: string;
  recurrenceFormat: "rrule" | "once";
  timezone: string;
  destination: "standalone" | "chat";
  sessionId?: string;
  projectPaths: string[];
  executionMode?: "local" | "worktree";
  model?: string;
  effort?: string;
  skillNames?: string[];
  pluginNames?: string[];
  permissionProfile?: {
    mode: "read_only" | "workspace_write" | "full_access";
    network?: boolean;
    allowedTools?: string[];
    deniedTools?: string[];
  };
  overlapPolicy?: "skip" | "queue";
  missedRunPolicy?: "skip" | "run_once";
  stopPolicy?: {
    runOnce?: boolean;
    maxRuns?: number;
    stopWhenCompleted?: boolean;
    expiresAt?: number;
  };
}

export interface AgentScheduledTask extends AgentScheduledTaskInput {
  id: string;
  status: "active" | "paused" | "completed";
  nextRunAt?: number;
  lastRunAt?: number;
  runCount: number;
}

export interface AgentScheduledRun {
  id: string;
  taskId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "interrupted" | "needs_attention" | "skipped";
  summary?: string;
  error?: string;
  sessionId?: string;
  runId?: string;
}

export interface AgentScheduleEffects {
  create(input: AgentScheduledTaskInput): Promise<AgentScheduledTask>;
  update(
    id: string,
    patch: Partial<AgentScheduledTaskInput> & {
      status?: AgentScheduledTask["status"];
    },
  ): Promise<AgentScheduledTask>;
  remove(id: string): Promise<void>;
  list(): Promise<AgentScheduledTask[]>;
  trigger(id: string): Promise<AgentScheduledRun>;
  listRuns(taskId?: string): Promise<AgentScheduledRun[]>;
}
