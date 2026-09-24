import type { ToolContext, ToolDefinition } from "@vykor/core";
import {
  WORKFLOW_SPEC_TEMPLATES,
  cancelPersistentWorkflow,
  createWorkflowNotification,
  createWorkflowRunId,
  createWorkflowResultFromSnapshot,
  createWorkflowValidationReport,
  createWorkflowSpecFromReconciliationPlan,
  formatWorkflowNotification,
  resumePersistentWorkflow,
  runWorkflow,
  runPersistentWorkflow,
  type WorkflowBudgetPolicyPreset,
  type WorkflowFailurePolicy,
  type WorkflowMode,
  type WorkflowRunEvent,
  type WorkflowRunRepository,
  type WorkflowRunSummary,
  type WorkflowRunSnapshot,
  type WorkflowRunner,
  type WorkflowSpec,
  type WorkflowTask,
  type WorkflowTemplateName,
} from "@vykor/coordinator";
import { createAgentWorkflowRunner } from "./runner.js";

const WORKFLOW_MODES = new Set<WorkflowMode>(["parallel", "sequential", "pipeline"]);
const FAILURE_POLICIES = new Set<WorkflowFailurePolicy>(["skip-dependents", "fail-fast", "continue"]);
const WORKFLOW_ACTIONS = new Set(["run", "resume", "timeline", "history", "template", "reconcile", "validate"]);
const BUDGET_POLICY_PRESETS = new Set<WorkflowBudgetPolicyPreset>(["cheap-review", "safe-write", "fast-parallel"]);

export interface WorkflowToolOptions {
  createRunner?: typeof createAgentWorkflowRunner;
  run?: typeof runWorkflow;
  stopTask?: (taskId: string) => Promise<unknown>;
  repository?: WorkflowRunRepository;
}

export function createWorkflowTool(options: WorkflowToolOptions): ToolDefinition {
  const createRunner = options.createRunner ?? createAgentWorkflowRunner;
  const run = options.run ?? runWorkflow;

  return {
    name: "Workflow",
    description:
      "Run a hard-scheduled multi-agent workflow. Use this when work has an explicit DAG, " +
      "sequential steps, a pipeline, retries, failure policy, or concurrency limits. " +
      "Detached runs return a jobId for JobRead, JobWait, and JobCancel. " +
      "For one-off delegation, Agent plus JobWait is still simpler.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["run", "resume", "timeline", "history", "template", "reconcile", "validate"],
          description: "Workflow domain action. Defaults to run. Use Jobs for ordinary status, list, wait, and cancel operations.",
        },
        taskIds: {
          type: "array",
          items: { type: "string" },
          description: "For action=timeline, include only events for these task ids.",
        },
        eventTypes: {
          type: "array",
          items: { type: "string" },
          description: "For action=timeline, include only these event types.",
        },
        statuses: {
          type: "array",
          items: { type: "string" },
          description: "For action=timeline, include only events with these statuses.",
        },
        runStatuses: {
          type: "array",
          items: { type: "string", enum: ["running", "completed", "failed"] },
          description: "For action=history, include only workflow runs with these statuses.",
        },
        limit: {
          type: "number",
          description: "For action=history, maximum number of workflow runs to return.",
        },
        runIdPrefix: {
          type: "string",
          description: "For action=history, include only workflow runs whose runId starts with this prefix.",
        },
        createdAfter: {
          description: "For action=history, include runs created at or after this timestamp. Accepts epoch milliseconds or an ISO date string.",
        },
        createdBefore: {
          description: "For action=history, include runs created at or before this timestamp. Accepts epoch milliseconds or an ISO date string.",
        },
        updatedAfter: {
          description: "For action=history, include runs updated at or after this timestamp. Accepts epoch milliseconds or an ISO date string.",
        },
        updatedBefore: {
          description: "For action=history, include runs updated at or before this timestamp. Accepts epoch milliseconds or an ISO date string.",
        },
        needsReconciliation: {
          type: "boolean",
          description: "For action=history, include only runs matching this reconciliation state.",
        },
        actionIds: {
          type: "array",
          items: { type: "string" },
          description: "For action=reconcile, include only these reconciliation follow-up action ids.",
        },
        issueIds: {
          type: "array",
          items: { type: "string" },
          description: "For action=reconcile, include only actions linked to these reconciliation issue ids.",
        },
        verifyTaskId: {
          type: "string",
          description: "For action=reconcile, override the generated verification task id.",
        },
        templateName: {
          type: "string",
          enum: ["research-implement-verify", "parallel-review", "safe-write"],
          description: "For action=template, return one built-in workflow template instead of all templates.",
        },
        templateParameters: {
          type: "object",
          description: "For action=template, override reusable template fields such as taskPrompts, writeScope, maxConcurrency, budgetPreset, or failurePolicy.",
        },
        mode: {
          type: "string",
          enum: ["parallel", "sequential", "pipeline"],
          description: "Scheduling mode. parallel honors dependsOn; sequential/pipeline chain tasks in order.",
        },
        tasks: {
          type: "array",
          description: "Workflow tasks. Each task normally becomes one spawned sub-agent.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable task id used by dependsOn" },
              description: { type: "string", description: "Short task description" },
              prompt: { type: "string", description: "Full prompt for this worker" },
              subagentType: { type: "string", description: "Agent type, such as Explore, worker, or a custom subagent" },
              model: { type: "string", description: "Model override" },
              team: { type: "string", description: "Optional team to attach the worker to" },
              permissionMode: {
                type: "string",
                enum: ["default", "plan", "full_auto"],
                description: "Worker permission mode",
              },
              dependsOn: {
                type: "array",
                items: { type: "string" },
                description: "Task ids that must finish before this task can run",
              },
              retry: {
                type: "object",
                properties: {
                  maxAttempts: { type: "number", description: "Total attempts including the first attempt" },
                  retryOn: {
                    type: "array",
                    items: { type: "string", enum: ["failed", "killed"] },
                    description: "Terminal statuses that should be retried",
                  },
                },
              },
              timeoutSeconds: {
                type: "number",
                description: "Hard timeout for each attempt of this task, in seconds.",
              },
              readOnly: {
                type: "boolean",
                description: "Marks the task as read-only so it can run alongside write-scoped tasks.",
              },
              writeScope: {
                type: "array",
                items: { type: "string" },
                description: "Paths this non-isolated write task may modify; overlapping scopes are serialized.",
              },
              isolate: {
                type: "boolean",
                description: "Run worker in an isolated worktree when the backend supports it",
              },
            },
            required: ["id"],
          },
        },
        maxConcurrency: {
          type: "number",
          description: "Parallel worker limit. Ignored by sequential and pipeline modes.",
        },
        defaultTaskTimeoutSeconds: {
          type: "number",
          description: "Default hard timeout for each task attempt, in seconds. Individual tasks can override it.",
        },
        budgetPolicy: {
          type: "object",
          properties: {
            maxTokensUsed: { type: "number", description: "Stop scheduling new work once known token usage reaches this value." },
            maxTimeUsedSeconds: { type: "number", description: "Stop scheduling new work once known task time usage reaches this value." },
            softMaxTokensUsed: { type: "number", description: "Enter soft budget mode once known token usage reaches this value." },
            softMaxTimeUsedSeconds: { type: "number", description: "Enter soft budget mode once known task time usage reaches this value." },
            onSoftLimit: {
              type: "string",
              enum: ["continue", "serialize", "conserve", "serialize-and-conserve"],
              description: "How to schedule remaining work after a soft budget is reached.",
            },
            conserve: {
              type: "object",
              properties: {
                promptHint: { type: "string", description: "Extra prompt guidance for workers started in budget conservation mode." },
                permissionMode: {
                  type: "string",
                  enum: ["default", "plan"],
                  description: "Permission mode override for conservation workers.",
                },
                maxTurns: { type: "number", description: "Max turns override for conservation workers." },
              },
            },
          },
        },
        budgetPreset: {
          type: "string",
          enum: ["cheap-review", "safe-write", "fast-parallel"],
          description: "Optional budget policy preset. Explicit budgetPolicy fields override preset defaults.",
        },
        failurePolicy: {
          type: "string",
          enum: ["skip-dependents", "fail-fast", "continue"],
          description: "How to react when a task fails. Defaults to skip-dependents.",
        },
        team: { type: "string", description: "Default team for tasks that do not set team" },
        timeoutSeconds: {
          type: "number",
          description: "Optional per-worker wait timeout in seconds. Omit it to let detached workflows continue until workers finish or task-level timeouts fire.",
        },
        waitForCompletion: {
          type: "boolean",
          description: "For action=run, wait for the full workflow result instead of returning after the persisted run is submitted. Defaults to false for persisted runs.",
        },
        permissionMode: {
          type: "string",
          enum: ["default", "plan", "full_auto"],
          description: "Default permission mode for tasks that do not set permissionMode",
        },
        persist: {
          type: "boolean",
          description: "Persist workflow run snapshots under the project .vykor/workflows directory. Defaults to true.",
        },
        runId: {
          type: "string",
          description: "Optional stable workflow run id for persistence and recovery.",
        },
        latest: {
          type: "boolean",
          description: "For resume/timeline/reconcile, use the latest owned persisted workflow run when runId is omitted.",
        },
      },
      required: [],
    },
    async execute(input, context) {
      const repository = options.repository;
      const onWorkflowEvent = undefined;
      const action = parseAction(input.action);
      if (!action) {
        return { content: [{ type: "text", text: "action must be one of: run, resume, timeline, history, template, reconcile, validate. Use JobRead, JobList, or JobCancel for lifecycle control." }], isError: true };
      }

      if (action === "validate") {
        return workflowValidate(input);
      }
      if (action === "timeline") {
        if (!repository) return missingWorkflowRepository();
        return workflowTimeline(input, repository, context.sessionId);
      }
      if (action === "history") {
        if (!repository) return missingWorkflowRepository();
        return workflowHistory(input, repository, context.sessionId);
      }
      if (action === "template") {
        return workflowTemplate(input);
      }
      if (action === "reconcile") {
        if (!repository) return missingWorkflowRepository();
        return workflowReconcile(input, repository, context.sessionId);
      }

      const specOrError = parseWorkflowSpec(input);
      if (action === "run" && typeof specOrError === "string") {
        return { content: [{ type: "text", text: specOrError }], isError: true };
      }

      try {
        const runnerTimeoutMs = secondsToOptionalMs(input.timeoutSeconds);
        if (runnerTimeoutMs === "invalid") {
          return { content: [{ type: "text", text: "timeoutSeconds must be a positive number" }], isError: true };
        }
        const runner = createRunner({
          cwd: context.cwd,
          sessionId: context.sessionId,
          team: asOptionalString(input.team),
          timeoutMs: runnerTimeoutMs,
          permissionMode: parsePermissionMode(input.permissionMode),
          agent: context.agent,
        });
        const persist = input.persist !== false;
        if ((action === "resume" || persist) && !repository) {
          return missingWorkflowRepository();
        }
        const runId = asOptionalString(input.runId) ?? (action === "run" && persist && options.run === undefined ? createWorkflowRunId() : undefined);
        const waitForCompletion = input.waitForCompletion === true || !persist || options.run !== undefined;
        if (action === "run" && persist && options.run === undefined && !waitForCompletion) {
          const store = repository!;
          const workflowRunId = runId ?? createWorkflowRunId();
          const ownerSignal = context.runAbortSignal ?? context.abortSignal;
          const onEvent = onWorkflowEvent;
          const cancelForParentInterrupt = () => {
            void cancelPersistentWorkflow(workflowRunId, {
              store,
              reason: "Parent session interrupted",
              stopTask: options.stopTask ?? ((taskId) => stopWorkflowTask(context, taskId, "Parent session interrupted")),
              onEvent,
            }).catch(() => {});
          };
          const workflow = runPersistentWorkflow(specOrError as WorkflowSpec, runner as WorkflowRunner, {
            runId: workflowRunId,
            ownerSession: context.sessionId,
            ownerInput: context.agent?.scope?.inputId,
            ownerRun: context.agent?.scope?.runId,
            store,
            onEvent,
            signal: ownerSignal,
          });
          if (ownerSignal?.aborted) {
            cancelForParentInterrupt();
          } else {
            ownerSignal?.addEventListener("abort", cancelForParentInterrupt, { once: true });
          }
          void workflow
            .catch((error) => {
              // The scheduler normally records task-level failures in snapshots. This
              // catch only prevents detached background runs from surfacing as
              // unhandled rejections if startup fails unexpectedly.
              console.error(`Detached workflow ${runId ?? "(unknown)"} failed: ${error instanceof Error ? error.message : String(error)}`);
            })
            .finally(() => ownerSignal?.removeEventListener("abort", cancelForParentInterrupt));
          const snapshot = store.load(workflowRunId);
          if (!snapshot) {
            return { content: [{ type: "text", text: "Workflow submitted, but no running snapshot was written yet." }], isError: true };
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                kind: "job",
                action: "created",
                jobId: `workflow:${snapshot.runId}`,
                jobKind: "workflow",
                label: snapshot.summary,
                status: snapshot.status,
              }),
            }],
          };
        }
        const result = action === "resume"
          ? await workflowResume(input, repository!, context.sessionId, runner as WorkflowRunner, onWorkflowEvent)
          : persist && options.run === undefined
            ? await runPersistentWorkflow(specOrError as WorkflowSpec, runner as WorkflowRunner, {
                runId,
                ownerSession: context.sessionId,
                ownerInput: context.agent?.scope?.inputId,
                ownerRun: context.agent?.scope?.runId,
                store: repository!,
                onEvent: onWorkflowEvent,
              })
            : runId
              ? await run(specOrError as WorkflowSpec, runner as WorkflowRunner, { runId })
              : await run(specOrError as WorkflowSpec, runner as WorkflowRunner);
        return {
          content: [{ type: "text", text: formatWorkflowNotification(result) }],
          ...(result.status === "failed" ? { isError: true } : {}),
        };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}

function workflowValidate(input: Record<string, unknown>) {
  const specOrError = parseWorkflowSpec(input);
  const report = typeof specOrError === "string"
    ? {
        valid: false,
        issues: [{
          severity: "error" as const,
          code: "invalid-workflow-input",
          message: specOrError,
        }],
      }
    : createWorkflowValidationReport(specOrError);
  return { content: [{ type: "text" as const, text: formatWorkflowValidationReport(report) }] };
}

function missingWorkflowRepository() {
  return {
    content: [{
      type: "text" as const,
      text: "Workflow durable repository is not configured for this runtime.",
    }],
    isError: true,
  };
}

function workflowTimeline(input: Record<string, unknown>, store: WorkflowRunRepository, ownerSession?: string) {
  const snapshot = loadWorkflowSnapshot(store, input, ownerSession);
  if (typeof snapshot === "string") {
    return { content: [{ type: "text" as const, text: snapshot }], isError: true };
  }
  const filters = parseTimelineFilters(input);
  const events = store.loadEvents(snapshot.runId);
  return { content: [{ type: "text" as const, text: formatWorkflowTimeline(snapshot, events, filters) }] };
}

function workflowHistory(input: Record<string, unknown>, store: WorkflowRunRepository, ownerSession?: string) {
  const filters = parseRunListFilters(input);
  if (typeof filters === "string") {
    return { content: [{ type: "text" as const, text: filters }], isError: true };
  }
  const runs = filterWorkflowRunSummaries(
    store.listSummaries().filter((run) => ownerSession === undefined || run.ownerSession === ownerSession),
    filters,
  )
    .slice(0, filters.limit ?? undefined);
  return {
    content: [{ type: "text" as const, text: formatWorkflowHistory(runs, filters) }],
  };
}

function workflowTemplate(input: Record<string, unknown>) {
  const templateName = input.templateName;
  if (templateName !== undefined && !isWorkflowTemplateName(templateName)) {
    return {
      content: [{ type: "text" as const, text: "templateName must be one of: research-implement-verify, parallel-review, safe-write" }],
      isError: true,
    };
  }
  const templates = templateName
    ? [applyWorkflowTemplateParameters(WORKFLOW_SPEC_TEMPLATES[templateName], input.templateParameters)]
    : Object.values(WORKFLOW_SPEC_TEMPLATES).map((template) => applyWorkflowTemplateParameters(template, input.templateParameters));
  return {
    content: [{ type: "text" as const, text: formatWorkflowTemplates(templates) }],
  };
}

function workflowReconcile(input: Record<string, unknown>, store: WorkflowRunRepository, ownerSession?: string) {
  const snapshot = loadWorkflowSnapshot(store, input, ownerSession);
  if (typeof snapshot === "string") {
    return { content: [{ type: "text" as const, text: snapshot }], isError: true };
  }
  const budgetPolicyPreset = input.budgetPreset;
  if (budgetPolicyPreset !== undefined && !isBudgetPolicyPreset(budgetPolicyPreset)) {
    return { content: [{ type: "text" as const, text: "budgetPreset must be one of: cheap-review, safe-write, fast-parallel" }], isError: true };
  }
  const notification = createWorkflowNotification(createWorkflowResultFromSnapshot(snapshot));
  const spec = createWorkflowSpecFromReconciliationPlan(notification.reconciliationPlan, {
    actionIds: parseStringArray(input.actionIds),
    issueIds: parseStringArray(input.issueIds),
    verifyTaskId: asOptionalString(input.verifyTaskId),
    budgetPolicyPreset,
  });
  if (!spec) {
    return { content: [{ type: "text" as const, text: "No reconciliation actions matched the requested workflow run" }], isError: true };
  }
  return {
    content: [{ type: "text" as const, text: formatWorkflowReconcileSpec(snapshot.runId, notification.reconciliationPlan, spec) }],
  };
}

async function stopWorkflowTask(
  context: ToolContext,
  taskId: string,
  reason: string,
): Promise<unknown> {
  if (context.agent?.children.hasChildAgent(taskId)) {
    return context.agent.children.interruptChildAgent(taskId, reason);
  }
  return stopTaskInCwd(context.cwd, context.sessionId, taskId);
}

async function workflowResume(
  input: Record<string, unknown>,
  store: WorkflowRunRepository,
  ownerSession: string | undefined,
  runner: WorkflowRunner,
  onEvent?: (event: WorkflowRunEvent) => void,
) {
  const snapshot = loadWorkflowSnapshot(store, input, ownerSession);
  if (typeof snapshot === "string") {
    throw new Error(snapshot);
  }
  return resumePersistentWorkflow(snapshot, runner, { store, onEvent });
}

function loadWorkflowSnapshot(
  store: WorkflowRunRepository,
  input: Record<string, unknown>,
  ownerSession?: string,
): WorkflowRunSnapshot | string {
  const runId = asOptionalString(input.runId);
  const snapshot = runId
    ? store.load(runId)
    : store.list().find((candidate) => ownerSession === undefined || candidate.ownerSession === ownerSession);
  if (!snapshot) {
    return runId ? `Workflow run not found: ${runId}` : "No workflow runs found";
  }
  if (ownerSession !== undefined && snapshot.ownerSession !== ownerSession) {
    return `Workflow run not found: ${snapshot.runId}`;
  }
  return snapshot;
}

function parseWorkflowSpec(input: Record<string, unknown>): WorkflowSpec | string {
  const mode = input.mode;
  if (!isWorkflowMode(mode)) {
    return "mode must be one of: parallel, sequential, pipeline";
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    return "tasks must be a non-empty array";
  }

  const failurePolicy = input.failurePolicy;
  if (failurePolicy !== undefined && !isFailurePolicy(failurePolicy)) {
    return "failurePolicy must be one of: skip-dependents, fail-fast, continue";
  }

  const maxConcurrency = input.maxConcurrency;
  if (maxConcurrency !== undefined && typeof maxConcurrency !== "number") {
    return "maxConcurrency must be a number";
  }
  const defaultTaskTimeoutMs = secondsToOptionalMs(input.defaultTaskTimeoutSeconds);
  if (defaultTaskTimeoutMs === "invalid") {
    return "defaultTaskTimeoutSeconds must be a positive number";
  }
  const budgetPolicyOrError = parseBudgetPolicy(input.budgetPolicy);
  if (typeof budgetPolicyOrError === "string") return budgetPolicyOrError;
  const budgetPolicyPreset = input.budgetPreset;
  if (budgetPolicyPreset !== undefined && !isBudgetPolicyPreset(budgetPolicyPreset)) {
    return "budgetPreset must be one of: cheap-review, safe-write, fast-parallel";
  }

  const tasks: WorkflowTask[] = [];
  for (const [index, rawTask] of input.tasks.entries()) {
    if (!isRecord(rawTask)) {
      return `tasks[${index}] must be an object`;
    }
    const taskOrError = parseWorkflowTask(rawTask, index);
    if (typeof taskOrError === "string") return taskOrError;
    tasks.push(taskOrError);
  }

  return {
    mode,
    tasks,
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(defaultTaskTimeoutMs !== undefined ? { defaultTaskTimeoutMs } : {}),
    ...(budgetPolicyPreset !== undefined ? { budgetPolicyPreset } : {}),
    ...(budgetPolicyOrError !== undefined ? { budgetPolicy: budgetPolicyOrError } : {}),
    ...(failurePolicy !== undefined ? { failurePolicy } : {}),
  };
}

function parseAction(value: unknown): "run" | "resume" | "timeline" | "history" | "template" | "reconcile" | "validate" | undefined {
  if (value === undefined) return "run";
  return typeof value === "string" && WORKFLOW_ACTIONS.has(value)
    ? value as "run" | "resume" | "timeline" | "history" | "template" | "reconcile" | "validate"
    : undefined;
}

function parseWorkflowTask(input: Record<string, unknown>, index: number): WorkflowTask | string {
  const id = input.id;
  if (typeof id !== "string" || id.trim() === "") {
    return `tasks[${index}].id must be a non-empty string`;
  }
  const retryOrError = parseRetry(input.retry, index);
  if (typeof retryOrError === "string") return retryOrError;
  const timeoutMs = secondsToOptionalMs(input.timeoutSeconds);
  if (timeoutMs === "invalid") {
    return `tasks[${index}].timeoutSeconds must be a positive number`;
  }

  return {
    id,
    description: asOptionalString(input.description),
    prompt: asOptionalString(input.prompt),
    subagentType: asOptionalString(input.subagentType),
    model: asOptionalString(input.model),
    team: asOptionalString(input.team),
    permissionMode: parsePermissionMode(input.permissionMode),
    dependsOn: parseStringArray(input.dependsOn),
    retry: retryOrError,
    timeoutMs,
    readOnly: typeof input.readOnly === "boolean" ? input.readOnly : undefined,
    writeScope: parseStringArray(input.writeScope),
    isolate: typeof input.isolate === "boolean" ? input.isolate : undefined,
  };
}

function parseRetry(input: unknown, taskIndex: number): WorkflowTask["retry"] | string {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return `tasks[${taskIndex}].retry must be an object`;
  const retryOn = parseStringArray(input.retryOn);
  const invalidRetryOn = retryOn?.find((status) => status !== "failed" && status !== "killed");
  if (invalidRetryOn) return `tasks[${taskIndex}].retry.retryOn contains invalid status '${invalidRetryOn}'`;
  const maxAttempts = input.maxAttempts;
  if (maxAttempts !== undefined && typeof maxAttempts !== "number") {
    return `tasks[${taskIndex}].retry.maxAttempts must be a number`;
  }
  return {
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(retryOn !== undefined ? { retryOn: retryOn as Array<"failed" | "killed"> } : {}),
  };
}

function parseBudgetPolicy(input: unknown): WorkflowSpec["budgetPolicy"] | string {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return "budgetPolicy must be an object";
  const maxTokensUsed = input.maxTokensUsed;
  const maxTimeUsedMs = secondsToOptionalMs(input.maxTimeUsedSeconds);
  const softMaxTokensUsed = input.softMaxTokensUsed;
  const softMaxTimeUsedMs = secondsToOptionalMs(input.softMaxTimeUsedSeconds);
  const onSoftLimit = input.onSoftLimit;
  const conserveOrError = parseConservePolicy(input.conserve);
  if (maxTokensUsed !== undefined && (typeof maxTokensUsed !== "number" || !Number.isFinite(maxTokensUsed) || maxTokensUsed <= 0)) {
    return "budgetPolicy.maxTokensUsed must be a positive number";
  }
  if (maxTimeUsedMs === "invalid") {
    return "budgetPolicy.maxTimeUsedSeconds must be a positive number";
  }
  if (softMaxTokensUsed !== undefined && (typeof softMaxTokensUsed !== "number" || !Number.isFinite(softMaxTokensUsed) || softMaxTokensUsed <= 0)) {
    return "budgetPolicy.softMaxTokensUsed must be a positive number";
  }
  if (softMaxTimeUsedMs === "invalid") {
    return "budgetPolicy.softMaxTimeUsedSeconds must be a positive number";
  }
  if (
    onSoftLimit !== undefined &&
    onSoftLimit !== "continue" &&
    onSoftLimit !== "serialize" &&
    onSoftLimit !== "conserve" &&
    onSoftLimit !== "serialize-and-conserve"
  ) {
    return "budgetPolicy.onSoftLimit must be one of: continue, serialize, conserve, serialize-and-conserve";
  }
  if (typeof conserveOrError === "string") return conserveOrError;
  return {
    ...(maxTokensUsed !== undefined ? { maxTokensUsed } : {}),
    ...(maxTimeUsedMs !== undefined ? { maxTimeUsedMs } : {}),
    ...(softMaxTokensUsed !== undefined ? { softMaxTokensUsed } : {}),
    ...(softMaxTimeUsedMs !== undefined ? { softMaxTimeUsedMs } : {}),
    ...(onSoftLimit !== undefined ? { onSoftLimit } : {}),
    ...(conserveOrError !== undefined ? { conserve: conserveOrError } : {}),
  };
}

function parseConservePolicy(input: unknown): NonNullable<WorkflowSpec["budgetPolicy"]>["conserve"] | string {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return "budgetPolicy.conserve must be an object";
  const promptHint = asOptionalString(input.promptHint);
  const permissionMode = input.permissionMode;
  const maxTurns = input.maxTurns;
  if (permissionMode !== undefined && permissionMode !== "default" && permissionMode !== "plan") {
    return "budgetPolicy.conserve.permissionMode must be one of: default, plan";
  }
  if (maxTurns !== undefined && (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1)) {
    return "budgetPolicy.conserve.maxTurns must be a positive integer";
  }
  return {
    ...(promptHint !== undefined ? { promptHint } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

function isWorkflowMode(value: unknown): value is WorkflowMode {
  return typeof value === "string" && WORKFLOW_MODES.has(value as WorkflowMode);
}

function isFailurePolicy(value: unknown): value is WorkflowFailurePolicy {
  return typeof value === "string" && FAILURE_POLICIES.has(value as WorkflowFailurePolicy);
}

function isBudgetPolicyPreset(value: unknown): value is WorkflowBudgetPolicyPreset {
  return typeof value === "string" && BUDGET_POLICY_PRESETS.has(value as WorkflowBudgetPolicyPreset);
}

function isWorkflowTemplateName(value: unknown): value is WorkflowTemplateName {
  return (
    value === "research-implement-verify" ||
    value === "parallel-review" ||
    value === "safe-write"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parsePermissionMode(value: unknown): "default" | "plan" | "full_auto" | undefined {
  if (value === "default" || value === "plan" || value === "full_auto") return value;
  return undefined;
}

function secondsToMs(value: unknown, defaultSeconds: number): number {
  return (typeof value === "number" ? value : defaultSeconds) * 1000;
}

function secondsToOptionalMs(value: unknown): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "invalid";
  return Math.floor(value * 1000);
}

function parsePositiveInteger(value: unknown): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return "invalid";
  return value;
}

function parseRunListFilters(input: Record<string, unknown>): RunListFilters | string {
  const statuses = parseRunStatuses(input.runStatuses);
  if (typeof statuses === "string") return statuses;
  const limit = parsePositiveInteger(input.limit);
  if (limit === "invalid") return "limit must be a positive integer";
  const createdAfter = parseTimestampFilter(input.createdAfter, "createdAfter");
  if (typeof createdAfter === "string") return createdAfter;
  const createdBefore = parseTimestampFilter(input.createdBefore, "createdBefore");
  if (typeof createdBefore === "string") return createdBefore;
  const updatedAfter = parseTimestampFilter(input.updatedAfter, "updatedAfter");
  if (typeof updatedAfter === "string") return updatedAfter;
  const updatedBefore = parseTimestampFilter(input.updatedBefore, "updatedBefore");
  if (typeof updatedBefore === "string") return updatedBefore;
  const budgetPreset = input.budgetPreset;
  if (budgetPreset !== undefined && !isBudgetPolicyPreset(budgetPreset)) {
    return "budgetPreset must be one of: cheap-review, safe-write, fast-parallel";
  }
  return {
    statuses,
    limit,
    runIdPrefix: asOptionalString(input.runIdPrefix),
    createdAfter,
    createdBefore,
    updatedAfter,
    updatedBefore,
    needsReconciliation: typeof input.needsReconciliation === "boolean" ? input.needsReconciliation : undefined,
    budgetPreset,
  };
}

function parseRunStatuses(value: unknown): Array<WorkflowRunSummary["status"]> | string | undefined {
  const statuses = parseStringArray(value);
  if (statuses === undefined) return undefined;
  const invalid = statuses.find((status) => status !== "running" && status !== "completed" && status !== "failed");
  return invalid ? "runStatuses must contain only: running, completed, failed" : statuses as Array<WorkflowRunSummary["status"]>;
}

function parseTimestampFilter(value: unknown, field: string): number | string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return `${field} must be an epoch millisecond number or ISO date string`;
}

interface TimelineFilters {
  taskIds?: string[];
  eventTypes?: string[];
  statuses?: string[];
}

interface RunListFilters {
  statuses?: Array<WorkflowRunSummary["status"]>;
  limit?: number;
  runIdPrefix?: string;
  createdAfter?: number;
  createdBefore?: number;
  updatedAfter?: number;
  updatedBefore?: number;
  needsReconciliation?: boolean;
  budgetPreset?: WorkflowBudgetPolicyPreset;
}

function parseTimelineFilters(input: Record<string, unknown>): TimelineFilters {
  return {
    taskIds: parseStringArray(input.taskIds),
    eventTypes: parseStringArray(input.eventTypes),
    statuses: parseStringArray(input.statuses),
  };
}

function filterWorkflowEvents(events: WorkflowRunEvent[], filters: TimelineFilters): WorkflowRunEvent[] {
  return events.filter((event) => {
    if (filters.taskIds && (!event.taskId || !filters.taskIds.includes(event.taskId))) return false;
    if (filters.eventTypes && !filters.eventTypes.includes(event.type)) return false;
    if (filters.statuses && (!event.status || typeof event.status !== "string" || !filters.statuses.includes(event.status))) return false;
    return true;
  });
}

function filterWorkflowRunSummaries(runs: WorkflowRunSummary[], filters: RunListFilters): WorkflowRunSummary[] {
  return runs.filter((run) => {
    if (filters.statuses && !filters.statuses.includes(run.status)) return false;
    if (filters.runIdPrefix && !run.runId.startsWith(filters.runIdPrefix)) return false;
    if (filters.createdAfter !== undefined && run.createdAt < filters.createdAfter) return false;
    if (filters.createdBefore !== undefined && run.createdAt > filters.createdBefore) return false;
    if (filters.updatedAfter !== undefined && run.updatedAt < filters.updatedAfter) return false;
    if (filters.updatedBefore !== undefined && run.updatedAt > filters.updatedBefore) return false;
    if (filters.needsReconciliation !== undefined && run.needsReconciliation !== filters.needsReconciliation) return false;
    if (filters.budgetPreset !== undefined && run.budgetPolicyPreset !== filters.budgetPreset) return false;
    return true;
  });
}

function formatWorkflowTimeline(snapshot: WorkflowRunSnapshot, events: WorkflowRunEvent[], filters: TimelineFilters = {}): string {
  const timeline = createWorkflowTimeline(filterWorkflowEvents(events, filters));
  return formatTimelineText(snapshot, timeline, filters, createTimelineSummary(timeline));
}

function createWorkflowTimeline(events: WorkflowRunEvent[]): Array<{ timestamp: number; type: string; taskId?: string; status?: string; summary: string }> {
  return events.map((event) => ({
    timestamp: event.timestamp,
    type: event.type,
    taskId: event.taskId,
    status: typeof event.status === "string" ? event.status : undefined,
    summary: event.summary ?? event.result?.summary ?? event.blockedTask?.reason ?? event.type,
  }));
}

function formatTimelineText(
  snapshot: WorkflowRunSnapshot,
  timeline: Array<{ timestamp: number; type: string; taskId?: string; status?: string; summary: string }>,
  filters: TimelineFilters = {},
  summary = createTimelineSummary(timeline),
): string {
  const lines = [
    `Workflow ${snapshot.runId} (${snapshot.status})`,
    snapshot.summary,
    `Events: ${summary.total} total; ${Object.entries(summary.byType).map(([type, count]) => `${type}=${count}`).join(" ")}`,
  ];
  const filterText = formatTimelineFilters(filters);
  if (filterText) lines.push(filterText);
  for (const event of timeline) {
    const task = event.taskId ? ` ${event.taskId}` : "";
    const status = event.status ? ` [${event.status}]` : "";
    lines.push(`- ${new Date(event.timestamp).toISOString()} ${event.type}${task}${status}: ${event.summary}`);
  }
  return lines.join("\n");
}

function createTimelineSummary(
  timeline: Array<{ timestamp: number; type: string; taskId?: string; status?: string; summary: string }>,
) {
  return {
    total: timeline.length,
    byType: countBy(timeline.map((event) => event.type)),
    byStatus: countBy(timeline.map((event) => event.status).filter((status): status is string => status !== undefined)),
    byTaskId: countBy(timeline.map((event) => event.taskId).filter((taskId): taskId is string => taskId !== undefined)),
  };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function formatTimelineFilters(filters: TimelineFilters): string | undefined {
  const parts = [
    filters.taskIds ? `taskIds=${filters.taskIds.join(",")}` : undefined,
    filters.eventTypes ? `eventTypes=${filters.eventTypes.join(",")}` : undefined,
    filters.statuses ? `statuses=${filters.statuses.join(",")}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? `Filters: ${parts.join(" ")}` : undefined;
}

function formatWorkflowHistory(
  runs: WorkflowRunSummary[],
  filters: RunListFilters = {},
): string {
  return [
    "<workflow-history>",
    `<payload>${escapeXml(JSON.stringify({ runs, total: runs.length, filters }))}</payload>`,
    "</workflow-history>",
  ].join("\n");
}

function formatWorkflowValidationReport(report: ReturnType<typeof createWorkflowValidationReport>): string {
  return [
    "<workflow-validation>",
    `<payload>${escapeXml(JSON.stringify(report))}</payload>`,
    "</workflow-validation>",
  ].join("\n");
}

function formatWorkflowReconcileSpec(
  sourceRunId: string,
  reconciliationPlan: ReturnType<typeof createWorkflowNotification>["reconciliationPlan"],
  spec: WorkflowSpec,
): string {
  return [
    "<workflow-reconcile-spec>",
    `<payload>${escapeXml(JSON.stringify({ sourceRunId, reconciliationPlan, spec }))}</payload>`,
    "</workflow-reconcile-spec>",
  ].join("\n");
}

function formatWorkflowTemplates(templates: Array<(typeof WORKFLOW_SPEC_TEMPLATES)[WorkflowTemplateName]>): string {
  return [
    "<workflow-templates>",
    `<payload>${escapeXml(JSON.stringify({ templates, total: templates.length }))}</payload>`,
    "</workflow-templates>",
  ].join("\n");
}

function applyWorkflowTemplateParameters(
  template: (typeof WORKFLOW_SPEC_TEMPLATES)[WorkflowTemplateName],
  parameters: unknown,
): (typeof WORKFLOW_SPEC_TEMPLATES)[WorkflowTemplateName] {
  if (!isRecord(parameters)) {
    return template;
  }
  const taskPrompts = isRecord(parameters.taskPrompts) ? parameters.taskPrompts : undefined;
  const writeScope = parseStringArray(parameters.writeScope);
  const maxConcurrency = typeof parameters.maxConcurrency === "number" ? Math.max(1, Math.floor(parameters.maxConcurrency)) : undefined;
  const budgetPolicyPreset = isBudgetPolicyPreset(parameters.budgetPreset) ? parameters.budgetPreset : undefined;
  const failurePolicy = isFailurePolicy(parameters.failurePolicy) ? parameters.failurePolicy : undefined;
  return {
    ...template,
    spec: {
      ...template.spec,
      ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
      ...(budgetPolicyPreset !== undefined ? { budgetPolicyPreset } : {}),
      ...(failurePolicy !== undefined ? { failurePolicy } : {}),
      tasks: template.spec.tasks.map((task) => {
        const promptValue = taskPrompts?.[task.id];
        const prompt = typeof promptValue === "string" ? promptValue : undefined;
        return {
          ...task,
          ...(prompt !== undefined ? { prompt } : {}),
          ...(writeScope && task.readOnly !== true ? { writeScope: [...writeScope] } : {}),
        };
      }),
    },
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function stopTaskInCwd(cwd: string, sessionId: string | undefined, taskId: string): Promise<unknown> {
  const {
    getChildAgentExecutionRegistry,
    getDetachedProcessSupervisor,
  } = await import("@vykor/services");
  try {
    return await getChildAgentExecutionRegistry({ cwd, sessionId }).stopExecution(taskId);
  } catch {
    return getDetachedProcessSupervisor({ cwd, sessionId }).stopExecution(taskId);
  }
}
