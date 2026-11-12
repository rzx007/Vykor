import { decodeWorkflowRunSnapshot } from "./store-decoding.js";

/** Visits only v1 execution paths. Text, commands and original events are never visited. */
export function relocateWorkflowSnapshotPaths(text: string, path: (value: string) => string, expected?: { runId: string; status: string }): string {
  const snapshot = decodeWorkflowRunSnapshot(text);
  if (expected && (snapshot.runId !== expected.runId || snapshot.status !== expected.status)) throw new Error("Workflow snapshot identity or status mismatch");
  const original = JSON.stringify(snapshot);
  const scope = (values: string[] | undefined) => values?.map(path);
  const metadata = (value: Record<string, unknown> | undefined) => {
    const tree = value?.worktree;
    if (tree && typeof tree === "object" && !Array.isArray(tree)) {
      const record = tree as { path?: unknown };
      if (typeof record.path !== "string") throw new Error("Invalid workflow worktree path");
      record.path = path(record.path);
    }
  };
  for (const task of [...snapshot.spec.tasks, ...snapshot.plan.tasks]) {
    if (task.writeScope) task.writeScope = scope(task.writeScope);
    metadata(task.metadata);
  }
  for (const task of [...Object.values(snapshot.runningTasks), ...Object.values(snapshot.results), ...snapshot.orderedResults]) metadata(task.metadata);
  for (const task of Object.values(snapshot.blockedTasks)) {
    if (task.writeScope) task.writeScope = scope(task.writeScope);
    if (task.conflictingWriteScope) task.conflictingWriteScope = scope(task.conflictingWriteScope);
  }
  const next = JSON.stringify(snapshot);
  return next === original ? text : next;
}
