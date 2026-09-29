export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  effort?: string | number;
  permissionMode?: string;
  maxTurns?: number;
  /** Optional wall-clock budget for one worker run; only set when the task type needs it. */
  timeoutSeconds?: number;
  skills?: string[];
  mcpServers?: unknown[];
  hooks?: Record<string, unknown>;
  color?: string;
  background?: boolean;
  initialPrompt?: string;
  memory?: string;
  isolation?: string;
  omitClaudeMd?: boolean;
  criticalSystemReminder?: string;
  requiredMcpServers?: string[];
  filename?: string;
  baseDir?: string;
  source?: "builtin" | "user" | "plugin";
  subagentType?: string;
  /** 额外权限规则串（Python-specific，仅存字段）。 */
  permissions?: string[];
}

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
