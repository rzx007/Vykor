import { cancelPersistentWorkflow, type WorkflowRunRepository } from "@vykor/coordinator";
import { DAEMON_RESTART_WORKFLOW_REASON } from "../support.js";
export interface WorkflowRecoveryContext {
  workflows: WorkflowRunRepository;
}

/**
 * Session runs and detached worker-process ownership die with the daemon process. Any durable
 * Workflow still marked running is therefore closed as interrupted during startup.
 */
export async function recoverInterruptedWorkflows(context: WorkflowRecoveryContext): Promise<void> {
  for (const snapshot of context.workflows.list().filter((run) => run.status === "running")) {
    if (!snapshot.ownerSession) continue;

    context.workflows.claim(snapshot.runId);
    await cancelPersistentWorkflow(snapshot, {
      store: context.workflows,
      reason: DAEMON_RESTART_WORKFLOW_REASON,
    });
  }
}
