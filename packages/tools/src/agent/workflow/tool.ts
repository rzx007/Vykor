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
  type WorkflowRunEvent,
  type WorkflowRunRepository,
  type WorkflowRunSnapshot,
  type WorkflowRunner,
  type WorkflowSpec,
} from "@vykor/coordinator";
import {
  asOptionalString,
  isBudgetPolicyPreset,
  isWorkflowTemplateName,
  parseAction,
  parsePermissionMode,
  parseRunListFilters,
  parseStringArray,
  parseTimelineFilters,
  parseWorkflowSpec,
  secondsToOptionalMs,
} from "./input.js";
import {
  applyWorkflowTemplateParameters,
  filterWorkflowRunSummaries,
  formatWorkflowHistory,
  formatWorkflowReconcileSpec,
  formatWorkflowTemplates,
  formatWorkflowTimeline,
  formatWorkflowValidationReport,
} from "./presentation.js";
import { createAgentWorkflowRunner } from "./runner.js";

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
