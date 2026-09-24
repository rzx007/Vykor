import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  WORKFLOW_SPEC_TEMPLATES,
  cancelPersistentWorkflow,
  createWorkflowNotification,
  createWorkflowResultFromSnapshot,
  createWorkflowSpecFromReconciliationPlan,
  createWorkflowValidationReport,
  FileWorkflowRunRepository,
  type WorkflowBudgetPolicyPreset,
  type WorkflowRunSummary,
  type WorkflowRunSnapshot,
  type WorkflowSpec,
  type WorkflowTemplateName,
} from "@vykor/coordinator";
import { getDetachedProcessSupervisor } from "@vykor/services";

interface CwdOption {
  cwd?: string;
}

interface SpecOptions extends CwdOption {
  spec?: string;
  specJson?: string;
}

interface ListOptions extends CwdOption {
  status?: string;
  limit?: string;
  runIdPrefix?: string;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  needsReconciliation?: boolean;
  budgetPreset?: string;
}

interface TemplateOptions {
  params?: string;
  paramsJson?: string;
}

interface ReconcileOptions extends CwdOption {
  actionIds?: string;
  issueIds?: string;
  verifyTaskId?: string;
  budgetPreset?: string;
}

interface CancelOptions extends CwdOption {
  reason?: string;
}

export function createWorkflowCommand(): Command {
  const cmd = new Command("workflow").description("Inspect and manage persisted workflow runs");

  cmd
    .command("list")
    .description("List persisted workflow run summaries")
    .option("--cwd <dir>", "Project working directory")
    .option("--status <statuses>", "Comma-separated statuses: running,completed,failed")
    .option("--limit <n>", "Maximum number of runs")
    .option("--run-id-prefix <prefix>", "Only include runs whose runId starts with this prefix")
    .option("--created-after <time>", "Only include runs created after this epoch ms or ISO date")
    .option("--created-before <time>", "Only include runs created before this epoch ms or ISO date")
    .option("--updated-after <time>", "Only include runs updated after this epoch ms or ISO date")
    .option("--updated-before <time>", "Only include runs updated before this epoch ms or ISO date")
    .option("--needs-reconciliation", "Only include runs that need reconciliation")
    .option("--budget-preset <preset>", "Only include runs with this budget preset")
    .action((options: ListOptions) => {
      const store = new FileWorkflowRunRepository({ cwd: options.cwd });
      printJson(createWorkflowListPayload(store.listSummaries(), options));
    });

  cmd
    .command("status")
    .description("Show one persisted workflow snapshot")
    .argument("[runId]", "Workflow run id. Defaults to latest run")
    .option("--cwd <dir>", "Project working directory")
    .option("--no-events", "Do not include persisted event timeline")
    .action((runId: string | undefined, options: CwdOption & { events?: boolean }) => {
      const store = new FileWorkflowRunRepository({ cwd: options.cwd });
      const snapshot = loadSnapshotOrThrow(store, runId);
      printJson({
        snapshot,
        ...(options.events === false ? {} : { events: store.loadEvents(snapshot.runId) }),
      });
    });

  cmd
    .command("validate")
    .description("Dry-run a workflow spec without launching workers")
    .option("--spec <path>", "Path to a workflow spec JSON file")
    .option("--spec-json <json>", "Workflow spec JSON string")
    .action((options: SpecOptions) => {
      printJson(createWorkflowValidationReport(readWorkflowSpec(options)));
    });

  cmd
    .command("template")
    .description("Show built-in workflow templates")
    .argument("[name]", "Template name")
    .option("--params <path>", "Path to template parameters JSON")
    .option("--params-json <json>", "Template parameters JSON string")
    .action((name: string | undefined, options: TemplateOptions) => {
      printJson(createWorkflowTemplatePayload(name, options));
    });

  cmd
    .command("reconcile")
    .description("Create a follow-up workflow spec from a run's reconciliation plan")
    .argument("[runId]", "Workflow run id. Defaults to latest run")
    .option("--cwd <dir>", "Project working directory")
    .option("--action-ids <ids>", "Comma-separated reconciliation action ids")
    .option("--issue-ids <ids>", "Comma-separated reconciliation issue ids")
    .option("--verify-task-id <id>", "Generated verification task id")
    .option("--budget-preset <preset>", "Budget preset for the generated workflow spec")
    .action((runId: string | undefined, options: ReconcileOptions) => {
      const store = new FileWorkflowRunRepository({ cwd: options.cwd });
      const snapshot = loadSnapshotOrThrow(store, runId);
      printJson(createWorkflowReconcilePayload(snapshot, options));
    });

  cmd
    .command("cancel")
    .description("Cancel a persisted running workflow and stop its detached worker processes")
    .argument("[runId]", "Workflow run id. Defaults to latest run")
    .option("--cwd <dir>", "Project working directory")
    .option("--reason <reason>", "Cancellation reason")
    .action(async (runId: string | undefined, options: CancelOptions) => {
      const store = new FileWorkflowRunRepository({ cwd: options.cwd });
      const snapshot = loadSnapshotOrThrow(store, runId);
      const result = await cancelPersistentWorkflow(snapshot, {
        store,
        reason: options.reason,
        stopTask: (taskId) => getDetachedProcessSupervisor().stopExecution(taskId),
      });
      printJson(createWorkflowNotification(result));
    });

  return cmd;
}

export function createWorkflowListPayload(runs: WorkflowRunSummary[], options: ListOptions = {}) {
  const filtered = runs.filter((run) => workflowRunMatches(run, options));
  const limit = parsePositiveIntegerOption(options.limit, "limit");
  return {
    runs: limit === undefined ? filtered : filtered.slice(0, limit),
    total: limit === undefined ? filtered.length : Math.min(filtered.length, limit),
    filters: {
      statuses: parseCsv(options.status),
      runIdPrefix: options.runIdPrefix,
      createdAfter: parseTimestampOption(options.createdAfter, "createdAfter"),
      createdBefore: parseTimestampOption(options.createdBefore, "createdBefore"),
      updatedAfter: parseTimestampOption(options.updatedAfter, "updatedAfter"),
      updatedBefore: parseTimestampOption(options.updatedBefore, "updatedBefore"),
      needsReconciliation: options.needsReconciliation,
      budgetPreset: options.budgetPreset,
      limit,
    },
  };
}

export function createWorkflowTemplatePayload(name: string | undefined, options: TemplateOptions = {}) {
  const parameters = readJsonOption(options.params, options.paramsJson) as Record<string, unknown> | undefined;
  const templates = name
    ? [templateByName(name)]
    : Object.values(WORKFLOW_SPEC_TEMPLATES);
  return {
    templates: parameters ? templates.map((template) => applyTemplateParameters(template, parameters)) : templates,
    total: templates.length,
  };
}

export function createWorkflowReconcilePayload(snapshot: WorkflowRunSnapshot, options: ReconcileOptions = {}) {
  const notification = createWorkflowNotification(createWorkflowResultFromSnapshot(snapshot));
  const budgetPolicyPreset = parseBudgetPreset(options.budgetPreset);
  const spec = createWorkflowSpecFromReconciliationPlan(notification.reconciliationPlan, {
    actionIds: parseCsv(options.actionIds),
    issueIds: parseCsv(options.issueIds),
    verifyTaskId: options.verifyTaskId,
    budgetPolicyPreset,
  });
  if (!spec) throw new Error("No reconciliation actions matched the requested workflow run");
  return {
    sourceRunId: snapshot.runId,
    reconciliationPlan: notification.reconciliationPlan,
    spec,
  };
}

export function readWorkflowSpec(options: SpecOptions): WorkflowSpec {
  const value = readJsonOption(options.spec, options.specJson);
  if (!isRecord(value)) {
    throw new Error("Workflow spec must be a JSON object. Pass --spec <path> or --spec-json <json>.");
  }
  return value as unknown as WorkflowSpec;
}

function workflowRunMatches(run: WorkflowRunSummary, options: ListOptions): boolean {
  const statuses = parseCsv(options.status);
  if (statuses && !statuses.includes(run.status)) return false;
  if (options.runIdPrefix && !run.runId.startsWith(options.runIdPrefix)) return false;
  const createdAfter = parseTimestampOption(options.createdAfter, "createdAfter");
  if (createdAfter !== undefined && run.createdAt < createdAfter) return false;
  const createdBefore = parseTimestampOption(options.createdBefore, "createdBefore");
  if (createdBefore !== undefined && run.createdAt > createdBefore) return false;
  const updatedAfter = parseTimestampOption(options.updatedAfter, "updatedAfter");
  if (updatedAfter !== undefined && run.updatedAt < updatedAfter) return false;
  const updatedBefore = parseTimestampOption(options.updatedBefore, "updatedBefore");
  if (updatedBefore !== undefined && run.updatedAt > updatedBefore) return false;
  if (options.needsReconciliation !== undefined && run.needsReconciliation !== options.needsReconciliation) return false;
  if (options.budgetPreset !== undefined && run.budgetPolicyPreset !== options.budgetPreset) return false;
  return true;
}

function loadSnapshotOrThrow(store: FileWorkflowRunRepository, runId: string | undefined): WorkflowRunSnapshot {
  const snapshot = runId ? store.load(runId) : store.latest();
  if (!snapshot) throw new Error(runId ? `Workflow run not found: ${runId}` : "No workflow runs found");
  return snapshot;
}

function templateByName(name: string) {
  if (!isWorkflowTemplateName(name)) {
    throw new Error("Template name must be one of: research-implement-verify, parallel-review, safe-write");
  }
  return WORKFLOW_SPEC_TEMPLATES[name];
}

function applyTemplateParameters(template: (typeof WORKFLOW_SPEC_TEMPLATES)[WorkflowTemplateName], parameters: Record<string, unknown>) {
  const taskPrompts = isRecord(parameters.taskPrompts) ? parameters.taskPrompts : undefined;
  const writeScope = parseStringArray(parameters.writeScope);
  const maxConcurrency = typeof parameters.maxConcurrency === "number" ? Math.max(1, Math.floor(parameters.maxConcurrency)) : undefined;
  const budgetPolicyPreset = parseBudgetPreset(typeof parameters.budgetPreset === "string" ? parameters.budgetPreset : undefined);
  const failurePolicy = typeof parameters.failurePolicy === "string" ? parameters.failurePolicy : undefined;
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

function readJsonOption(path: string | undefined, inlineJson: string | undefined): unknown {
  if (path && inlineJson) throw new Error("Pass either a file path or inline JSON, not both.");
  if (inlineJson) return JSON.parse(inlineJson);
  if (path) return JSON.parse(readFileSync(resolve(path), "utf-8"));
  return undefined;
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
  return items.length === 0 ? undefined : items;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function parsePositiveIntegerOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseTimestampOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber;
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) return asDate;
  throw new Error(`${label} must be an epoch millisecond number or ISO date string`);
}

function parseBudgetPreset(value: string | undefined): WorkflowBudgetPolicyPreset | undefined {
  if (value === undefined) return undefined;
  if (value === "cheap-review" || value === "safe-write" || value === "fast-parallel") return value;
  throw new Error("budgetPreset must be one of: cheap-review, safe-write, fast-parallel");
}

function isWorkflowTemplateName(value: string): value is WorkflowTemplateName {
  return value === "research-implement-verify" || value === "parallel-review" || value === "safe-write";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
