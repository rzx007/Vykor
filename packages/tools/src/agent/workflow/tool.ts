import type { AgentDefinition } from "@vykor/coordinator/definitions";
import type { ToolDefinition } from "@vykor/agent-contracts";
import { parseAction } from "@vykor/coordinator/workflow";
import type { WorkflowToolPort } from "../../ports/workflow.js";
export function createWorkflowTool(port: WorkflowToolPort, definitions?: readonly AgentDefinition[]): ToolDefinition {
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
          enum: [
            "run",
            "resume",
            "timeline",
            "history",
            "template",
            "reconcile",
            "validate",
          ],
          description:
            "Workflow domain action. Defaults to run. Use Jobs for ordinary status, list, wait, and cancel operations.",
        },
        taskIds: {
          type: "array",
          items: { type: "string" },
          description:
            "For action=timeline, include only events for these task ids.",
        },
        eventTypes: {
          type: "array",
          items: { type: "string" },
          description: "For action=timeline, include only these event types.",
        },
        statuses: {
          type: "array",
          items: { type: "string" },
          description:
            "For action=timeline, include only events with these statuses.",
        },
        runStatuses: {
          type: "array",
          items: { type: "string", enum: ["running", "completed", "failed"] },
          description:
            "For action=history, include only workflow runs with these statuses.",
        },
        limit: {
          type: "number",
          description:
            "For action=history, maximum number of workflow runs to return.",
        },
        runIdPrefix: {
          type: "string",
          description:
            "For action=history, include only workflow runs whose runId starts with this prefix.",
        },
        createdAfter: {
          description:
            "For action=history, include runs created at or after this timestamp. Accepts epoch milliseconds or an ISO date string.",
        },
        createdBefore: {
          description:
            "For action=history, include runs created at or before this timestamp. Accepts epoch milliseconds or an ISO date string.",
        },
        updatedAfter: {
          description:
            "For action=history, include runs updated at or after this timestamp. Accepts epoch milliseconds or an ISO date string.",
        },
        updatedBefore: {
          description:
            "For action=history, include runs updated at or before this timestamp. Accepts epoch milliseconds or an ISO date string.",
        },
        needsReconciliation: {
          type: "boolean",
          description:
            "For action=history, include only runs matching this reconciliation state.",
        },
        actionIds: {
          type: "array",
          items: { type: "string" },
          description:
            "For action=reconcile, include only these reconciliation follow-up action ids.",
        },
        issueIds: {
          type: "array",
          items: { type: "string" },
          description:
            "For action=reconcile, include only actions linked to these reconciliation issue ids.",
        },
        verifyTaskId: {
          type: "string",
          description:
            "For action=reconcile, override the generated verification task id.",
        },
        templateName: {
          type: "string",
          enum: ["research-implement-verify", "parallel-review", "safe-write"],
          description:
            "For action=template, return one built-in workflow template instead of all templates.",
        },
        templateParameters: {
          type: "object",
          description:
            "For action=template, override reusable template fields such as taskPrompts, writeScope, maxConcurrency, budgetPreset, or failurePolicy.",
        },
        mode: {
          type: "string",
          enum: ["parallel", "sequential", "pipeline"],
          description:
            "Scheduling mode. parallel honors dependsOn; sequential/pipeline chain tasks in order.",
        },
        tasks: {
          type: "array",
          description:
            "Workflow tasks. Each task normally becomes one spawned sub-agent.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Stable task id used by dependsOn",
              },
              description: {
                type: "string",
                description: "Short task description",
              },
              prompt: {
                type: "string",
                description: "Full prompt for this worker",
              },
              subagentType: {
                type: "string",
                description:
                  "Agent type, such as Explore, worker, or a custom subagent",
              },
              model: { type: "string", description: "Model override" },
              team: {
                type: "string",
                description: "Optional team to attach the worker to",
              },
              permissionMode: {
                type: "string",
                enum: ["default", "plan", "full_auto"],
                description: "Worker permission mode",
              },
              dependsOn: {
                type: "array",
                items: { type: "string" },
                description:
                  "Task ids that must finish before this task can run",
              },
              retry: {
                type: "object",
                properties: {
                  maxAttempts: {
                    type: "number",
                    description: "Total attempts including the first attempt",
                  },
                  retryOn: {
                    type: "array",
                    items: { type: "string", enum: ["failed", "killed"] },
                    description: "Terminal statuses that should be retried",
                  },
                },
              },
              timeoutSeconds: {
                type: "number",
                description:
                  "Hard timeout for each attempt of this task, in seconds.",
              },
              readOnly: {
                type: "boolean",
                description:
                  "Marks the task as read-only so it can run alongside write-scoped tasks.",
              },
              writeScope: {
                type: "array",
                items: { type: "string" },
                description:
                  "Paths this non-isolated write task may modify; overlapping scopes are serialized.",
              },
              isolate: {
                type: "boolean",
                description:
                  "Run worker in an isolated worktree when the backend supports it",
              },
            },
            required: ["id"],
          },
        },
        maxConcurrency: {
          type: "number",
          description:
            "Parallel worker limit. Ignored by sequential and pipeline modes.",
        },
        defaultTaskTimeoutSeconds: {
          type: "number",
          description:
            "Default hard timeout for each task attempt, in seconds. Individual tasks can override it.",
        },
        budgetPolicy: {
          type: "object",
          properties: {
            maxTokensUsed: {
              type: "number",
              description:
                "Stop scheduling new work once known token usage reaches this value.",
            },
            maxTimeUsedSeconds: {
              type: "number",
              description:
                "Stop scheduling new work once known task time usage reaches this value.",
            },
            softMaxTokensUsed: {
              type: "number",
              description:
                "Enter soft budget mode once known token usage reaches this value.",
            },
            softMaxTimeUsedSeconds: {
              type: "number",
              description:
                "Enter soft budget mode once known task time usage reaches this value.",
            },
            onSoftLimit: {
              type: "string",
              enum: [
                "continue",
                "serialize",
                "conserve",
                "serialize-and-conserve",
              ],
              description:
                "How to schedule remaining work after a soft budget is reached.",
            },
            conserve: {
              type: "object",
              properties: {
                promptHint: {
                  type: "string",
                  description:
                    "Extra prompt guidance for workers started in budget conservation mode.",
                },
                permissionMode: {
                  type: "string",
                  enum: ["default", "plan"],
                  description:
                    "Permission mode override for conservation workers.",
                },
                maxTurns: {
                  type: "number",
                  description: "Max turns override for conservation workers.",
                },
              },
            },
          },
        },
        budgetPreset: {
          type: "string",
          enum: ["cheap-review", "safe-write", "fast-parallel"],
          description:
            "Optional budget policy preset. Explicit budgetPolicy fields override preset defaults.",
        },
        failurePolicy: {
          type: "string",
          enum: ["skip-dependents", "fail-fast", "continue"],
          description:
            "How to react when a task fails. Defaults to skip-dependents.",
        },
        team: {
          type: "string",
          description: "Default team for tasks that do not set team",
        },
        timeoutSeconds: {
          type: "number",
          description:
            "Optional per-worker timeout cap in seconds. The effective limit is the smaller of this cap and the task override (or defaultTaskTimeoutSeconds). It is saved with the workflow and retained on resume. Omit it to use only task/default limits.",
        },
        waitForCompletion: {
          type: "boolean",
          description:
            "For action=run, wait for the full workflow result instead of returning after the persisted run is submitted. Defaults to false for persisted runs.",
        },
        permissionMode: {
          type: "string",
          enum: ["default", "plan", "full_auto"],
          description:
            "Default permission mode for tasks that do not set permissionMode",
        },
        persist: {
          type: "boolean",
          description:
            "Persist workflow run snapshots under the project .vykor/workflows directory. Defaults to true.",
        },
        runId: {
          type: "string",
          description:
            "Optional stable workflow run id for persistence and recovery.",
        },
        latest: {
          type: "boolean",
          description:
            "For resume/timeline/reconcile, use the latest owned persisted workflow run when runId is omitted.",
        },
      },
      required: [],
    },
    async execute(input, context) {
      if (!parseAction(input.action))
        return {
          content: [
            {
              type: "text",
              text: "action must be one of: run, resume, timeline, history, template, reconcile, validate. Use JobRead, JobList, or JobCancel for lifecycle control.",
            },
          ],
          isError: true,
        };
      const scope = context.agent?.scope;
      if (!scope)
        return {
          content: [
            { type: "text", text: "Workflow execution scope is unavailable." },
          ],
          isError: true,
        };
      return await port.invoke({
        input,
        scope,
        signal: context.abortSignal ?? scope.signal,
        children: context.agent?.children,
        definitions,
      });
    },
  };
}
