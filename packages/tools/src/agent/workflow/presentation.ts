import { WORKFLOW_SPEC_TEMPLATES, createWorkflowNotification, createWorkflowValidationReport, type WorkflowRunEvent, type WorkflowRunSummary, type WorkflowRunSnapshot, type WorkflowSpec, type WorkflowTemplateName } from "@vykor/coordinator";
import { isBudgetPolicyPreset, isFailurePolicy, isRecord, parseStringArray, type RunListFilters, type TimelineFilters } from "./input.js";

function filterWorkflowEvents(events: WorkflowRunEvent[], filters: TimelineFilters): WorkflowRunEvent[] {
  return events.filter((event) => {
    if (filters.taskIds && (!event.taskId || !filters.taskIds.includes(event.taskId))) return false;
    if (filters.eventTypes && !filters.eventTypes.includes(event.type)) return false;
    if (filters.statuses && (!event.status || typeof event.status !== "string" || !filters.statuses.includes(event.status))) return false;
    return true;
  });
}

export function filterWorkflowRunSummaries(runs: WorkflowRunSummary[], filters: RunListFilters): WorkflowRunSummary[] {
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

export function formatWorkflowTimeline(snapshot: WorkflowRunSnapshot, events: WorkflowRunEvent[], filters: TimelineFilters = {}): string {
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

export function formatWorkflowHistory(
  runs: WorkflowRunSummary[],
  filters: RunListFilters = {},
): string {
  return [
    "<workflow-history>",
    `<payload>${escapeXml(JSON.stringify({ runs, total: runs.length, filters }))}</payload>`,
    "</workflow-history>",
  ].join("\n");
}

export function formatWorkflowValidationReport(report: ReturnType<typeof createWorkflowValidationReport>): string {
  return [
    "<workflow-validation>",
    `<payload>${escapeXml(JSON.stringify(report))}</payload>`,
    "</workflow-validation>",
  ].join("\n");
}

export function formatWorkflowReconcileSpec(
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

export function formatWorkflowTemplates(templates: Array<(typeof WORKFLOW_SPEC_TEMPLATES)[WorkflowTemplateName]>): string {
  return [
    "<workflow-templates>",
    `<payload>${escapeXml(JSON.stringify({ templates, total: templates.length }))}</payload>`,
    "</workflow-templates>",
  ].join("\n");
}

export function applyWorkflowTemplateParameters(
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
