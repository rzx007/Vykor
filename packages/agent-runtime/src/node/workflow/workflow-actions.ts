import {
  WORKFLOW_SPEC_TEMPLATES,
  createWorkflowNotification,
  createWorkflowRunId,
  createWorkflowResultFromSnapshot,
  createWorkflowValidationReport,
  createWorkflowSpecFromReconciliationPlan,
  formatWorkflowNotification,
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
} from "@vykor/coordinator/workflow";
import {
  applyWorkflowTemplateParameters,
  filterWorkflowRunSummaries,
  formatWorkflowHistory,
  formatWorkflowReconcileSpec,
  formatWorkflowTemplates,
  formatWorkflowTimeline,
  formatWorkflowValidationReport,
} from "./workflow-presentation.js";
export function workflowValidate(input: Record<string, unknown>) {
  const specOrError = parseWorkflowSpec(input);
  const report =
    typeof specOrError === "string"
      ? {
          valid: false,
          issues: [
            {
              severity: "error" as const,
              code: "invalid-workflow-input",
              message: specOrError,
            },
          ],
        }
      : createWorkflowValidationReport(specOrError);
  return {
    content: [
      { type: "text" as const, text: formatWorkflowValidationReport(report) },
    ],
  };
}

export function missingWorkflowRepository() {
  return {
    content: [
      {
        type: "text" as const,
        text: "Workflow durable repository is not configured for this runtime.",
      },
    ],
    isError: true,
  };
}

export function workflowTimeline(
  input: Record<string, unknown>,
  store: WorkflowRunRepository,
  ownerSession?: string,
) {
  const snapshot = loadWorkflowSnapshot(store, input, ownerSession);
  if (typeof snapshot === "string") {
    return {
      content: [{ type: "text" as const, text: snapshot }],
      isError: true,
    };
  }
  const filters = parseTimelineFilters(input);
  const events = store.loadEvents(snapshot.runId);
  return {
    content: [
      {
        type: "text" as const,
        text: formatWorkflowTimeline(snapshot, events, filters),
      },
    ],
  };
}

export function workflowHistory(
  input: Record<string, unknown>,
  store: WorkflowRunRepository,
  ownerSession?: string,
) {
  const filters = parseRunListFilters(input);
  if (typeof filters === "string") {
    return {
      content: [{ type: "text" as const, text: filters }],
      isError: true,
    };
  }
  const runs = filterWorkflowRunSummaries(
    store
      .listSummaries()
      .filter(
        (run) =>
          ownerSession === undefined || run.ownerSession === ownerSession,
      ),
    filters,
  ).slice(0, filters.limit ?? undefined);
  return {
    content: [
      { type: "text" as const, text: formatWorkflowHistory(runs, filters) },
    ],
  };
}

export function workflowTemplate(input: Record<string, unknown>) {
  const templateName = input.templateName;
  if (templateName !== undefined && !isWorkflowTemplateName(templateName)) {
    return {
      content: [
        {
          type: "text" as const,
          text: "templateName must be one of: research-implement-verify, parallel-review, safe-write",
        },
      ],
      isError: true,
    };
  }
  const templates = templateName
    ? [
        applyWorkflowTemplateParameters(
          WORKFLOW_SPEC_TEMPLATES[templateName],
          input.templateParameters,
        ),
      ]
    : Object.values(WORKFLOW_SPEC_TEMPLATES).map((template) =>
        applyWorkflowTemplateParameters(template, input.templateParameters),
      );
  return {
    content: [
      { type: "text" as const, text: formatWorkflowTemplates(templates) },
    ],
  };
}

export function workflowReconcile(
  input: Record<string, unknown>,
  store: WorkflowRunRepository,
  ownerSession?: string,
) {
  const snapshot = loadWorkflowSnapshot(store, input, ownerSession);
  if (typeof snapshot === "string") {
    return {
      content: [{ type: "text" as const, text: snapshot }],
      isError: true,
    };
  }
  const budgetPolicyPreset = input.budgetPreset;
  if (
    budgetPolicyPreset !== undefined &&
    !isBudgetPolicyPreset(budgetPolicyPreset)
  ) {
    return {
      content: [
        {
          type: "text" as const,
          text: "budgetPreset must be one of: cheap-review, safe-write, fast-parallel",
        },
      ],
      isError: true,
    };
  }
  const notification = createWorkflowNotification(
    createWorkflowResultFromSnapshot(snapshot),
  );
  const spec = createWorkflowSpecFromReconciliationPlan(
    notification.reconciliationPlan,
    {
      actionIds: parseStringArray(input.actionIds),
      issueIds: parseStringArray(input.issueIds),
      verifyTaskId: asOptionalString(input.verifyTaskId),
      budgetPolicyPreset,
    },
  );
  if (!spec) {
    return {
      content: [
        {
          type: "text" as const,
          text: "No reconciliation actions matched the requested workflow run",
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: formatWorkflowReconcileSpec(
          snapshot.runId,
          notification.reconciliationPlan,
          spec,
        ),
      },
    ],
  };
}

export function loadWorkflowSnapshot(
  store: WorkflowRunRepository,
  input: Record<string, unknown>,
  ownerSession?: string,
): WorkflowRunSnapshot | string {
  const runId = asOptionalString(input.runId);
  const snapshot = runId
    ? store.load(runId)
    : store
        .list()
        .find(
          (candidate) =>
            ownerSession === undefined ||
            candidate.ownerSession === ownerSession,
        );
  if (!snapshot) {
    return runId
      ? `Workflow run not found: ${runId}`
      : "No workflow runs found";
  }
  if (ownerSession !== undefined && snapshot.ownerSession !== ownerSession) {
    return `Workflow run not found: ${snapshot.runId}`;
  }
  return snapshot;
}
