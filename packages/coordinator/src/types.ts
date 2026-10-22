import type { AgentDefinition } from "./definitions/types.js";

export type CoordinatorMode = "sequential" | "parallel" | "pipeline";

export interface CoordinatorConfig {
  mode: CoordinatorMode;
  agents: AgentDefinition[];
}

export interface TaskNotification {
  taskId: string;
  status: "completed" | "failed" | "killed";
  summary: string;
  result?: string;
  usage?: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
}
