import type { Settings } from "@vykor/host-config";
import type { ShellDescriptor } from "@vykor/environment";

export interface McpAuthConfigureInput {
  serverName: string;
  mode: "bearer" | "header" | "env";
  value: string;
  key?: string;
}

export interface McpAuthConfigureResult {
  message: string;
}

export interface McpAuthHost {
  configure(input: McpAuthConfigureInput): Promise<McpAuthConfigureResult>;
}

/** Host-owned creation boundary for detached shell jobs. */
export interface AgentBackgroundShellHost {
  create(input: {
    /** Stable identity for one logical creation request; retries must reuse it. */
    requestId: string;
    cwd: string;
    sessionId: string;
    command: string;
    description: string;
    /** Working directory inside the acquired execution environment. */
    executionCwd?: string;
    settings?: Settings;
    shellDescriptor?: ShellDescriptor;
  }): Promise<{
    jobId: string;
    label: string;
  }>;
}
