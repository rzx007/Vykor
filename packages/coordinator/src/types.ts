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
