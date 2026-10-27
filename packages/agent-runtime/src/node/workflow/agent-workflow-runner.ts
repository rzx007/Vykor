import type { AgentChildController } from "@vykor/agent-contracts";
import type { ExecutionRuntimeOwner } from "@vykor/execution-node";
import type {
  AgentDefinition,
  WorkflowConservePolicy,
  WorkflowDiffSummary,
  WorkflowRunner,
  WorkflowTask,
  WorkflowWorkerResult,
} from "@vykor/coordinator";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AwaitExecutionResult } from "@vykor/execution-node";

import { promisify } from "node:util";
import { awaitFrameworkChildTask } from "../children/child-task-adapter.js";

const execFileAsync = promisify(execFile);
const GIT_SUMMARY_TIMEOUT_MS = 2_000;

export interface WorkflowWorkerSpawnConfig {
  name: string;
  team: string;
  prompt: string;
  cwd: string;
  parentSessionId: string;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: "default" | "plan" | "full_auto";
  isolate?: boolean;
  allowedTools?: string[];
  requiredMcpServers?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  effort?: string;
}

export interface WorkflowWorkerSpawnResult {
  success: boolean;
  agentId: string;
  taskId: string;
  sessionId?: string;
  runId?: string;
  backendType: string;
  error?: string;
  worktree?: { path: string; branch: string };
  notice?: string;
}

export interface AgentWorkflowRunnerOptions {
  executionOwner?: ExecutionRuntimeOwner;
  cwd: string;
  sessionId?: string;
  team?: string;
  timeoutMs?: number;
  permissionMode?: "default" | "plan" | "full_auto";
  fromAgent?: string;
  agent?: { children: AgentChildController };
  spawnWorker?: (
    config: WorkflowWorkerSpawnConfig,
  ) => Promise<WorkflowWorkerSpawnResult>;
  awaitTask?: (
    taskId: string,
    options?: { timeoutMs?: number },
  ) => Promise<AwaitExecutionResult>;
  stopTask?: (taskId: string) => Promise<unknown>;
  getChangedFiles?: (cwd: string) => Promise<string[]>;
  getDiffSummary?: (cwd: string) => Promise<WorkflowDiffSummary>;
  getAgentDefinition?: (name: string) => AgentDefinition | undefined;
}

/** Run each scheduled worker through the owning Node host. */
export function createAgentWorkflowRunner(
  options: AgentWorkflowRunnerOptions,
): WorkflowRunner {
  return async ({
    task,
    attempt,
    dependencyResults,
    pipelineInput,
    resumeFrom,
    budgetMode,
    budgetConserve,
    reportProgress,
    signal,
    deadlineAt,
  }) => {
    signal?.throwIfAborted();
    const prompt = buildWorkerPrompt(
      task,
      dependencyResults,
      pipelineInput,
      budgetMode,
      budgetConserve,
    );
    const subagentType = task.subagentType ?? "worker";
    const agentDef = options.getAgentDefinition
      ? options.getAgentDefinition(subagentType)
      : undefined;
    const waitTimeoutMs = earliestDefined(
      options.timeoutMs,
      agentDef?.timeoutSeconds !== undefined
        ? agentDef.timeoutSeconds * 1_000
        : undefined,
      deadlineAt !== undefined
        ? Math.max(0, deadlineAt - Date.now())
        : undefined,
    );
    const team = task.team ?? options.team ?? "default";
    const workerSessionId = createWorkerSessionId(task.id, attempt);
    const spawnBase =
      options.spawnWorker ??
      ((config: WorkflowWorkerSpawnConfig) =>
        defaultSpawnWorker(options.cwd, config, options.agent));
    const spawnWorker = async (config: WorkflowWorkerSpawnConfig) => {
      signal?.throwIfAborted();
      const worker = await spawnBase(config);
      if (signal?.aborted && worker.success) {
        await stopTask(worker.taskId);
        signal.throwIfAborted();
      }
      return worker;
    };
    const wait =
      options.awaitTask ??
      ((taskId, waitOptions) =>
        defaultAwaitTask(
          options.cwd,
          options.sessionId,
          taskId,
          waitOptions,
          options.agent,
          options.executionOwner,
        ));
    const awaitTask: NonNullable<
      AgentWorkflowRunnerOptions["awaitTask"]
    > = async (taskId, waitOptions) => {
      if (!signal) return await wait(taskId, waitOptions);
      let aborted = () => {};
      try {
        return await Promise.race([
          wait(taskId, waitOptions),
          new Promise<never>((_, reject) => {
            aborted = () => {
              void (async () => {
                await stopTask(taskId);
                await wait(taskId);
                signal.throwIfAborted();
              })().catch(reject);
            };
            signal.addEventListener("abort", aborted, { once: true });
            if (signal.aborted) aborted();
          }),
        ]);
      } finally {
        signal.removeEventListener("abort", aborted);
      }
    };
    const stopTask =
      options.stopTask ??
      ((taskId) =>
        defaultStopTask(
          options.cwd,
          options.sessionId,
          taskId,
          options.agent,
          options.executionOwner,
        ));

    const resumedTaskId = getStringMetadata(
      resumeFrom?.metadata,
      "workerTaskId",
    );
    if (resumedTaskId) {
      try {
        reportProgress?.({
          summary: `Waiting for existing task ${resumedTaskId}`,
          metadata: resumeFrom?.metadata,
        });
        const waited = await stopTimedOutTask(
          stopTask,
          resumedTaskId,
          await awaitTask(resumedTaskId, { timeoutMs: waitTimeoutMs }),
          awaitTask,
        );
        const spawn = {
          success: true,
          agentId:
            getStringMetadata(resumeFrom?.metadata, "agentId") ??
            `${subagentType}@${team}`,
          taskId: resumedTaskId,
          backendType:
            getStringMetadata(resumeFrom?.metadata, "backendType") ?? "resumed",
          worktree: getWorktreeMetadata(resumeFrom?.metadata),
          notice: getStringMetadata(resumeFrom?.metadata, "notice"),
        } satisfies WorkflowWorkerSpawnResult;
        const diff = await getDiffSummaryForWorker(options, spawn);
        return mapAwaitedTaskToWorkerResult(task, spawn, waited, diff);
      } catch (error) {
        reportProgress?.({
          summary: `Existing task ${resumedTaskId} unavailable; spawning replacement`,
          metadata: {
            ...resumeFrom?.metadata,
            resumeError: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    const spawn = await spawnWorker({
      name: subagentType,
      team,
      prompt,
      cwd: options.cwd,
      parentSessionId: options.sessionId ?? "main",
      sessionId: workerSessionId,
      model: task.model ?? agentDef?.model,
      systemPrompt: agentDef?.systemPrompt,
      permissionMode: normalizePermissionMode(
        budgetMode === "conserve"
          ? (budgetConserve?.permissionMode ??
              task.permissionMode ??
              options.permissionMode ??
              agentDef?.permissionMode)
          : (task.permissionMode ??
              options.permissionMode ??
              agentDef?.permissionMode),
      ),
      isolate: task.isolate === true,
      allowedTools: agentDef?.tools,
      requiredMcpServers: agentDef?.requiredMcpServers,
      disallowedTools: agentDef?.disallowedTools,
      maxTurns:
        budgetMode === "conserve"
          ? (budgetConserve?.maxTurns ?? agentDef?.maxTurns)
          : agentDef?.maxTurns,
      effort: agentDef?.effort != null ? String(agentDef.effort) : undefined,
    });

    if (!spawn.success) {
      return {
        status: "failed",
        summary: spawn.error ?? "Failed to spawn workflow worker",
        metadata: {
          agentId: spawn.agentId,
          workerTaskId: spawn.taskId,
      ...(spawn.runId ? { workerRunId: spawn.runId } : {}),
          backendType: spawn.backendType,
        },
      };
    }

    reportProgress?.({
      summary: `Waiting for task ${spawn.taskId}`,
      metadata: spawnMetadata(spawn),
    });
    const waited = await stopTimedOutTask(
      stopTask,
      spawn.taskId,
      await awaitTask(spawn.taskId, { timeoutMs: waitTimeoutMs }),
      awaitTask,
    );
    reportProgress?.({
      summary: `Worker task ${spawn.taskId} ${waited.timedOut ? "timed out" : "finished"}; collecting changes`,
      metadata: spawnMetadata(spawn),
    });
    const diff = await getDiffSummaryForWorker(options, spawn);
    return mapAwaitedTaskToWorkerResult(task, spawn, waited, diff);
  };
}

const CLEANUP_GRACE_MS = 5_000;

async function stopTimedOutTask(
  stopTask: (taskId: string) => Promise<unknown>,
  taskId: string,
  waited: AwaitExecutionResult,
  awaitTask: (
    taskId: string,
    options?: { timeoutMs?: number },
  ) => Promise<AwaitExecutionResult>,
): Promise<AwaitExecutionResult> {
  if (!waited.timedOut) return waited;
  let stopRequested = false;
  try {
    await stopTask(taskId);
    stopRequested = true;
  } catch {
    // A failed stop still leaves cleanup unconfirmed; keep the timeout result.
  }
  const confirmed = stopRequested
    ? await awaitTask(taskId, { timeoutMs: CLEANUP_GRACE_MS }).catch(
        () => undefined,
      )
    : undefined;
  if (confirmed && confirmed.status !== "running" && !confirmed.timedOut)
    return confirmed;
  return { ...waited, cleanupUnconfirmed: true };
}

function earliestDefined(
  ...values: Array<number | undefined>
): number | undefined {
  const defined = values.filter(
    (value): value is number => value !== undefined,
  );
  return defined.length > 0 ? Math.min(...defined) : undefined;
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

function mapAwaitedTaskToWorkerResult(
  task: WorkflowTask,
  spawn: WorkflowWorkerSpawnResult,
  waited: AwaitExecutionResult,
  diff: WorkflowDiffSummary | undefined,
): WorkflowWorkerResult {
  const status = waited.timedOut
    ? "failed"
    : waited.failureKind === "completed" ||
        (!waited.failureKind && waited.status === "completed")
      ? "completed"
      : waited.failureKind === "interrupted" ||
          waited.failureKind === "stopped" ||
          (!waited.failureKind && waited.status === "stopped")
        ? "killed"
        : "failed";
  const detail = waited.timedOut
    ? `did not finish before timeout`
    : waited.exitCode != null
      ? `finished with exit code ${waited.exitCode}`
      : `finished with status ${waited.status}`;
  return {
    status,
    summary: `${task.id} ${detail}`,
    result: waited.output,
    metadata: {
      agentId: spawn.agentId,
      workerTaskId: spawn.taskId,
      ...(spawn.runId ? { workerRunId: spawn.runId } : {}),
      backendType: spawn.backendType,
      ...(spawn.worktree ? { worktree: spawn.worktree } : {}),
      ...(spawn.notice ? { notice: spawn.notice } : {}),
      ...(diff && diff.changedFiles.length > 0
        ? { changedFiles: diff.changedFiles, diff }
        : {}),
      ...(waited.timedOut ? { timedOut: true } : {}),
      ...(waited.cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
      ...(waited.failureKind ? { failureKind: waited.failureKind } : {}),
      ...(waited.childFailureKind
        ? { childFailureKind: waited.childFailureKind }
        : {}),
      ...(waited.partialResult ? { partialResult: waited.partialResult } : {}),
    },
  };
}

function spawnMetadata(
  spawn: WorkflowWorkerSpawnResult,
): Record<string, unknown> {
  return {
    agentId: spawn.agentId,
    workerTaskId: spawn.taskId,
      ...(spawn.runId ? { workerRunId: spawn.runId } : {}),
    backendType: spawn.backendType,
    ...(spawn.worktree ? { worktree: spawn.worktree } : {}),
    ...(spawn.notice ? { notice: spawn.notice } : {}),
  };
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
): WorkflowWorkerSpawnResult["worktree"] | undefined {
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
  spawn: WorkflowWorkerSpawnResult,
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

async function defaultSpawnWorker(
  cwd: string,
  config: WorkflowWorkerSpawnConfig,
  agent?: { children: AgentChildController },
): Promise<WorkflowWorkerSpawnResult> {
  const agentId = `${config.name}@${config.team}`;
  if (!agent) {
    return {
      success: false,
      agentId,
      taskId: "",
      backendType: "framework",
      error: "No framework execution context registered for workflow worker",
    };
  }
  const invocation = await agent.children.spawnChildAgent({
    description: agentId,
    prompt: config.prompt,
    agent: config.name,
    team: config.team,
    cwd,
    sessionId: config.sessionId,
    model: config.model,
    systemPrompt: config.systemPrompt,
    permissionMode: config.permissionMode,
    isolate: config.isolate,
    allowedTools: config.allowedTools,
    requiredMcpServers: config.requiredMcpServers,
    disallowedTools: config.disallowedTools,
    maxTurns: config.maxTurns,
    effort: config.effort,
  });
  return {
    success: true,
    agentId,
    taskId: invocation.id,
      runId: invocation.runId,
    sessionId: invocation.sessionId,
    backendType: "framework",
    worktree: invocation.worktree,
    notice: invocation.notice,
  };
}

async function defaultAwaitTask(
  cwd: string,
  sessionId: string | undefined,
  taskId: string,
  options?: { timeoutMs?: number },
  agent?: { children: AgentChildController },
  executionOwner?: ExecutionRuntimeOwner,
): Promise<AwaitExecutionResult> {
  if (agent?.children.hasChildAgent(taskId)) {
    return await awaitFrameworkChildTask(
      agent.children,
      taskId,
      options?.timeoutMs,
    );
  }
  if (!executionOwner)
    throw new Error(
      "Workflow host must supply an execution owner or awaitTask",
    );
  return executionOwner
    .getDetachedProcessSupervisor({ cwd, sessionId })
    .awaitExecution(taskId, options);
}

async function defaultStopTask(
  cwd: string,
  sessionId: string | undefined,
  taskId: string,
  agent?: { children: AgentChildController },
  executionOwner?: ExecutionRuntimeOwner,
): Promise<unknown> {
  if (agent?.children.hasChildAgent(taskId)) {
    await agent.children.interruptChildAgent(taskId, "Workflow task timed out");
    await agent.children.awaitChildAgent(taskId);
    return;
  }
  if (!executionOwner)
    throw new Error("Workflow host must supply an execution owner or stopTask");
  return executionOwner
    .getDetachedProcessSupervisor({ cwd, sessionId })
    .stopExecution(taskId);
}

function createWorkerSessionId(taskId: string, attempt: number): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `wf-${taskId}-${attempt}-${Date.now().toString(36)}-${rand}`;
}

function normalizePermissionMode(
  value: string | undefined,
): "default" | "plan" | "full_auto" | undefined {
  if (value === "default" || value === "plan" || value === "full_auto") {
    return value;
  }
  return undefined;
}
