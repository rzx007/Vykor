import type {
  AgentChildSpawnInput,
  AgentChildResult,
} from "@vykor/agent-contracts";
export interface AgentChildEnvironmentLease {
  cwd: string;
  worktree?: {
    path: string;
    branch: string;
  };
  release(result: AgentChildResult): Promise<void>;
}
export interface AgentChildEnvironmentProvider {
  acquire(
    input: AgentChildSpawnInput,
    childId: string,
  ): Promise<AgentChildEnvironmentLease>;
}
export function createInProcessChildEnvironmentProvider(): AgentChildEnvironmentProvider {
  return {
    async acquire(input) {
      return { cwd: input.cwd, async release() {} };
    },
  };
}
