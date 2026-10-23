import type { WorkflowHost } from "@vykor/agent-runtime/node/workflow";
import { DAEMON_RESTART_WORKFLOW_REASON } from "../../support.js";
export interface WorkflowRecoveryContext {
  workflowHost: WorkflowHost;
}

/**
 * Session runs and detached worker-process ownership die with the daemon process. Any durable
 * Workflow still marked running is therefore closed as interrupted during startup.
 */
export async function recoverInterruptedWorkflows(context: WorkflowRecoveryContext): Promise<void> {
  const { workflowHost } = context;
  for (const snapshot of workflowHost.repository.list().filter((run) => run.status === "running")) {
    if (!snapshot.ownerSession) continue;

    workflowHost.repository.claim(snapshot.runId);
    await workflowHost.cancelPersistentWorkflow(snapshot, {
      reason: DAEMON_RESTART_WORKFLOW_REASON,
    });
  }
}
