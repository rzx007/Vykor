export type McpRuntimeStatus = "connected" | "disconnected" | "error" | "unavailable";

export interface McpRuntimeSyncResult {
  status: McpRuntimeStatus;
  affectedRuntimes: number;
  failures: Array<{ runtimeId: string; message: string }>;
}
