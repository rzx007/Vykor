import type { AgentChildController, AgentChildDirectory, AgentChildInvocation, AgentChildResult } from "@vykor/agent-contracts";
import type { AgentDefinition, WorkflowConservePolicy, WorkflowDiffSummary, WorkflowRunner, WorkflowTask } from "@vykor/coordinator";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const GIT_SUMMARY_TIMEOUT_MS = 2_000;

export interface AgentWorkflowRunnerOptions {
  cwd: string;
  sessionId?: string;
  team?: string;
  permissionMode?: "default" | "plan" | "full_auto";
  agent?: { children: AgentChildController };
  children?: AgentChildDirectory;
  getChangedFiles?: (cwd: string) => Promise<string[]>;
  getDiffSummary?: (cwd: string) => Promise<WorkflowDiffSummary>;
  getAgentDefinition?: (name: string) => AgentDefinition | undefined;
}
interface WorkerReceipt { agentId: string; taskId: string; runId: string; worktree?: AgentChildInvocation["worktree"]; notice?: string }

/** Only the real child owns execution; coordinator owns deadlines and retries. */
export function createAgentWorkflowRunner(options: AgentWorkflowRunnerOptions): WorkflowRunner {
  return async ({ task, attempt, dependencyResults, pipelineInput, resumeFrom, budgetMode, budgetConserve, reportProgress, signal }) => {
    signal?.throwIfAborted();
    const name = task.subagentType ?? "worker";
    const definition = options.getAgentDefinition?.(name);
    const team = task.team ?? options.team ?? "default";
    let receipt: WorkerReceipt;
    let actualResult: AgentChildInvocation["result"] | undefined;
    if (resumeFrom) {
      const taskId = getStringMetadata(resumeFrom.metadata, "workerTaskId");
      const runId = getStringMetadata(resumeFrom.metadata, "workerRunId");
      if (!taskId || !runId) throw unconfirmedWorkerError("Workflow worker receipt is unavailable; execution cannot be replayed", resumeFrom.metadata);
      receipt = { taskId, runId, agentId: getStringMetadata(resumeFrom.metadata, "agentId") ?? `${name}@${team}`,
        worktree: getWorktreeMetadata(resumeFrom.metadata), notice: getStringMetadata(resumeFrom.metadata, "notice") };
    } else {
      if (!options.agent) throw new Error("Workflow worker child controller is unavailable");
      const workerSessionId = createWorkerSessionId(task.id, attempt);
      let child: AgentChildInvocation;
      try { child = await options.agent.children.spawnChildAgent({
        description: `${name}@${team}`, agent: name, team, cwd: options.cwd,
        sessionId: workerSessionId,
        prompt: buildWorkerPrompt(task, dependencyResults, pipelineInput, budgetMode, budgetConserve),
        model: task.model ?? definition?.model, systemPrompt: definition?.systemPrompt,
        permissionMode: normalizePermissionMode(budgetMode === "conserve"
          ? budgetConserve?.permissionMode ?? task.permissionMode ?? options.permissionMode ?? definition?.permissionMode
          : task.permissionMode ?? options.permissionMode ?? definition?.permissionMode),
        isolate: task.isolate === true, allowedTools: definition?.tools,
        requiredMcpServers: definition?.requiredMcpServers, disallowedTools: definition?.disallowedTools,
        maxTurns: budgetMode === "conserve" ? budgetConserve?.maxTurns ?? definition?.maxTurns : definition?.maxTurns,
        effort: definition?.effort != null ? String(definition.effort) : undefined,
        timeoutSeconds: definition?.timeoutSeconds,
      }); } catch (error) {
        // A failed started ACK can still own a running child or unreleased
        // preparation. Settle that exact worker session before retry is safe.
        const original = options.children?.getBySessionId(workerSessionId);
        if (original) {
          try { await original.close(); }
          catch (cleanupError) { throw unconfirmedWorkerError(String(error), { workerTaskId: original.id, workerRunId: original.runId, cleanupError: String(cleanupError) }); }
        }
        throw error;
      }
      actualResult = child.result;
      receipt = { agentId: `${name}@${team}`, taskId: child.id, runId: child.runId, worktree: child.worktree, notice: child.notice };
    }
    const handle = options.children?.get(receipt.taskId);
    if (!handle) {
      const error = `Workflow worker handle is unavailable: ${receipt.taskId}`;
      if (actualResult) return queryFailureResult(receipt, error, await actualResult);
      throw unconfirmedWorkerError(error, spawnMetadata(receipt));
    }
    // Capture this exact run's existing result barrier before any query can fail.
    // Promise identity is never used to decide which run it belongs to.
    if (!actualResult && handle.runId === receipt.runId) actualResult = handle.result;
    reportProgress?.({ summary: `Waiting for child ${receipt.taskId}`, metadata: spawnMetadata(receipt) });
    const stop = () => { void handle.interruptRun(receipt.runId, "Workflow attempt stopped").catch(() => {
      reportProgress?.({ metadata: { ...spawnMetadata(receipt), cleanupUnconfirmed: true } });
    }); };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    try {
      let snapshot: Awaited<ReturnType<typeof handle.waitRun>>;
      try {
        handle.readRun(receipt.runId);
        snapshot = await handle.waitRun(receipt.runId);
      } catch (error) {
        reportProgress?.({ summary: "Worker query failed; waiting for its actual stop", metadata: { ...spawnMetadata(receipt), stopping: true, cleanupUnconfirmed: true } });
        await handle.interruptRun(receipt.runId, "Workflow worker query failed").catch(() => {});
        if (!actualResult) throw unconfirmedWorkerError(String(error), spawnMetadata(receipt));
        const actual = await actualResult;
        // Query failure never schedules a substitute, even after actual stop.
        return queryFailureResult(receipt, String(error), actual);
      }
      if (!snapshot.result) throw new Error("Workflow child stop is unconfirmed");
      const result = snapshot.result;
      const diff = await getDiffSummaryForWorker(options, receipt);
      if (result.status === "completed" && !snapshot.projectionError) await handle.requestSuspend?.(receipt.runId);
      return {
        status: result.status === "completed" ? "completed" : result.status === "interrupted" || result.status === "stopped" ? "killed" : "failed",
        summary: `${task.id} finished with status ${result.status}`, result: result.output,
        metadata: { ...spawnMetadata(receipt),
          ...("failureKind" in result && result.failureKind ? { failureKind: result.failureKind } : {}),
          ...("partialResult" in result && result.partialResult ? { partialResult: result.partialResult } : {}),
          ...("delivery" in result && result.delivery ? { delivery: result.delivery } : {}),
          ...(snapshot.cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
          ...(snapshot.projectionError ? { projectionError: snapshot.projectionError } : {}),
          ...(diff && diff.changedFiles.length ? { changedFiles: diff.changedFiles, diff } : {}),
        },
      };
    } finally { signal?.removeEventListener("abort", stop); }
  };
}

function buildWorkerPrompt(
  task: WorkflowTask,
  dependencyResults: Record<
    string,
    { status: string; summary: string; result?: string }
  >,
  pipelineInput:
    { status: string; summary: string; result?: string } | undefined,
  budgetMode: "normal" | "conserve" | undefined,
  budgetConserve: WorkflowConservePolicy | undefined,
): string {
  const parts = [task.prompt ?? task.description ?? task.id];
  if (budgetMode === "conserve") {
    parts.push(
      "\nBudget conservation mode:",
      budgetConserve?.promptHint ??
        "Keep the response concise, avoid broad exploration, and prefer read-only verification unless edits are essential.",
    );
  }
  const dependencyEntries = Object.entries(dependencyResults);
  if (dependencyEntries.length > 0) {
    parts.push(
      "\nDependency results:",
      ...dependencyEntries.map(([taskId, result]) =>
        formatDependencyResult(taskId, result),
      ),
    );
  }
  if (pipelineInput) {
    parts.push(
      "\nPipeline input:",
      formatDependencyResult("previous", pipelineInput),
    );
  }
  return parts.join("\n");
}

function formatDependencyResult(
  taskId: string,
  result: { status: string; summary: string; result?: string },
): string {
  const lines = [`- ${taskId}: ${result.status} - ${result.summary}`];
  if (result.result) {
    lines.push(indentBlock(result.result));
  }
  return lines.join("\n");
}

function indentBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

function spawnMetadata(spawn: WorkerReceipt): Record<string, unknown> {
  return { agentId: spawn.agentId, workerTaskId: spawn.taskId, workerRunId: spawn.runId,
    ...(spawn.worktree ? { worktree: spawn.worktree } : {}), ...(spawn.notice ? { notice: spawn.notice } : {}) };
}

function getStringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function getWorktreeMetadata(
  metadata: Record<string, unknown> | undefined,
): WorkerReceipt["worktree"] | undefined {
  const value = metadata?.worktree;
  if (!value || typeof value !== "object") return undefined;
  const worktree = value as { path?: unknown; branch?: unknown };
  return typeof worktree.path === "string" &&
    typeof worktree.branch === "string"
    ? { path: worktree.path, branch: worktree.branch }
    : undefined;
}

async function getDiffSummaryForWorker(
  options: AgentWorkflowRunnerOptions,
  spawn: WorkerReceipt,
): Promise<WorkflowDiffSummary | undefined> {
  const cwd = spawn.worktree?.path ?? options.cwd;
  try {
    if (options.getDiffSummary)
      return normalizeDiffSummary(await options.getDiffSummary(cwd));
    const changedFiles = options.getChangedFiles
      ? normalizeChangedFiles(await options.getChangedFiles(cwd))
      : undefined;
    return normalizeDiffSummary(await defaultGetDiffSummary(cwd, changedFiles));
  } catch {
    return undefined;
  }
}

async function defaultGetDiffSummary(
  cwd: string,
  knownChangedFiles?: string[],
): Promise<WorkflowDiffSummary> {
  if (!hasGitMetadata(cwd)) {
    return buildDiffSummary([], new Map(), knownChangedFiles);
  }
  const statusResult = await execFileAsync(
    "git",
    ["-C", cwd, "status", "--porcelain", "--untracked-files=all"],
    {
      windowsHide: true,
      timeout: GIT_SUMMARY_TIMEOUT_MS,
    },
  );
  const numstatResult = await execFileAsync(
    "git",
    ["-C", cwd, "diff", "--numstat", "HEAD", "--"],
    {
      windowsHide: true,
      timeout: GIT_SUMMARY_TIMEOUT_MS,
    },
  ).catch(() => ({ stdout: "" }));
  return buildDiffSummary(
    parseGitStatusPorcelain(statusResult.stdout),
    parseGitDiffNumstat(numstatResult.stdout),
    knownChangedFiles,
  );
}

function hasGitMetadata(cwd: string): boolean {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function parseGitStatusPorcelain(output: string): Array<{
  path: string;
  status: WorkflowDiffSummary["files"][number]["status"];
}> {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => {
      const code = line.slice(0, 2);
      const path = line.slice(3).split(" -> ").pop() ?? line.slice(3);
      return { path, status: statusFromPorcelainCode(code) };
    })
    .filter((file) => file.path.length > 0);
}

function parseGitDiffNumstat(
  output: string,
): Map<string, { insertions: number; deletions: number }> {
  const stats = new Map<string, { insertions: number; deletions: number }>();
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [insertions, deletions, ...pathParts] = line.split(/\t/);
    const path = pathParts.join("\t").split(" => ").pop();
    if (!path) continue;
    stats.set(path, {
      insertions: parseNumstatCount(insertions),
      deletions: parseNumstatCount(deletions),
    });
  }
  return stats;
}

function buildDiffSummary(
  statusFiles: Array<{
    path: string;
    status: WorkflowDiffSummary["files"][number]["status"];
  }>,
  stats: Map<string, { insertions: number; deletions: number }>,
  knownChangedFiles: string[] | undefined,
): WorkflowDiffSummary {
  const filesByPath = new Map<string, WorkflowDiffSummary["files"][number]>();
  for (const file of statusFiles) {
    const path = normalizeChangedFile(file.path);
    if (!path) continue;
    const stat = stats.get(file.path) ?? stats.get(path);
    filesByPath.set(path, {
      path,
      status: file.status,
      ...(stat
        ? { insertions: stat.insertions, deletions: stat.deletions }
        : {}),
    });
  }
  for (const file of knownChangedFiles ?? []) {
    const path = normalizeChangedFile(file);
    if (!path || filesByPath.has(path)) continue;
    const stat = stats.get(file) ?? stats.get(path);
    filesByPath.set(path, {
      path,
      status: "other",
      ...(stat
        ? { insertions: stat.insertions, deletions: stat.deletions }
        : {}),
    });
  }
  return normalizeDiffSummary({
    changedFiles: [...filesByPath.keys()],
    files: [...filesByPath.values()],
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    untracked: 0,
    insertions: 0,
    deletions: 0,
  });
}

function statusFromPorcelainCode(
  code: string,
): WorkflowDiffSummary["files"][number]["status"] {
  if (code.includes("?")) return "untracked";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("M")) return "modified";
  return "other";
}

function parseNumstatCount(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeChangedFiles(files: string[]): string[] {
  return [
    ...new Set(
      files.map(normalizeChangedFile).filter((file) => file.length > 0),
    ),
  ].sort();
}

function normalizeChangedFile(file: string): string {
  return file.trim().replace(/\\/g, "/");
}

function normalizeDiffSummary(diff: WorkflowDiffSummary): WorkflowDiffSummary {
  const files = diff.files
    .map((file) => ({
      ...file,
      path: normalizeChangedFile(file.path),
      insertions: file.insertions,
      deletions: file.deletions,
    }))
    .filter((file) => file.path.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));
  const count = (status: WorkflowDiffSummary["files"][number]["status"]) =>
    files.filter((file) => file.status === status).length;
  return {
    changedFiles: normalizeChangedFiles(
      diff.changedFiles.length > 0
        ? diff.changedFiles
        : files.map((file) => file.path),
    ),
    files,
    added: count("added"),
    modified: count("modified"),
    deleted: count("deleted"),
    renamed: count("renamed"),
    untracked: count("untracked"),
    insertions: files.reduce(
      (total, file) => total + (file.insertions ?? 0),
      0,
    ),
    deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
  };
}

function createWorkerSessionId(taskId: string, attempt: number): string {
  return `wf-${taskId}-${attempt}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
function normalizePermissionMode(value: string | undefined): "default" | "plan" | "full_auto" | undefined {
  return value === "default" || value === "plan" || value === "full_auto" ? value : undefined;
}

function unconfirmedWorkerError(message: string, metadata?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { cleanupUnconfirmed: true, metadata });
}

function queryFailureResult(receipt: WorkerReceipt, error: string, actual: AgentChildResult): import("@vykor/coordinator").WorkflowWorkerResult {
  return { status: "failed", summary: error, result: actual.output,
    metadata: { ...spawnMetadata(receipt), retryable: false, workerQueryFailed: true,
      ...(actual.failureKind ? { failureKind: actual.failureKind } : {}),
      ...(actual.partialResult ? { partialResult: actual.partialResult } : {}), ...(actual.delivery ? { delivery: actual.delivery } : {}) } };
}
