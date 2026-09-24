# @vykor/jobs

Portable control protocol for long-running Vykor work.

The package defines owner-scoped snapshots and the common `list`, `read`, `wait`, `send`, and
`cancel` operations. Producers keep ownership of execution and storage: terminals remain in the
terminal state remains in its provider, detached processes in `DetachedProcessSupervisor`, child Agent handles in `ChildAgentExecutionRegistry`, durable projections in `SessionExecutionRecord`, and workflows in
`FileWorkflowRunRepository`.

See [Jobs 统一后台任务协议](../../docs/jobs-protocol.md) for lifecycle, ownership, cursor, and
adapter requirements. The proposed hard cut from Task/Workflow-specific controls is documented in
[Jobs Task/Workflow Convergence](../../docs/jobs-task-workflow-convergence.md).
