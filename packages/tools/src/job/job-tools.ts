import type { ToolContext, ToolDefinition, ToolResult } from "@vykor/agent-contracts";
import type { AgentJobAuthorization, AgentJobHost, JobTarget, JobKind, JobStatus } from "@vykor/jobs";

const DEFAULT_JOB_LIST_LIMIT = 100;
const MAX_JOB_WAIT_IDS = 32;
const MAX_JOB_WAIT_MS = 60_000;
const targetProperty = { type: "object", properties: { kind: { type: "string", enum: ["agent", "shell", "terminal", "workflow", "dream"] }, jobId: { type: "string" }, runId: { type: "string", description: "Required for agent targets; pins one accepted run" } }, required: ["kind", "jobId"] };
function jobTarget(value: unknown): JobTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("target is required");
  const input = value as Record<string, unknown>;
  const kind = requiredString(input.kind, "target.kind");
  const jobId = requiredString(input.jobId, "target.jobId");
  if (kind === "agent") return { kind, jobId, runId: requiredString(input.runId, "target.runId") };
  if (kind !== "shell" && kind !== "terminal" && kind !== "workflow" && kind !== "dream") throw new Error("Unsupported target kind");
  return { kind, jobId };
}


export function createJobTools(port?: AgentJobHost, authorization?: AgentJobAuthorization): ToolDefinition[] {
  const jobListTool: ToolDefinition = {
    name: "JobList",
    description: "List the latest terminal, background task, child-agent, and workflow jobs owned by this session. Returns at most 100 by default.",
    inputSchema: {
      type: "object",
      properties: {
        kinds: {
          type: "array",
          items: { type: "string", enum: ["terminal", "shell", "agent", "dream", "workflow"] },
          description: "Only return these job kinds",
        },
        statuses: {
          type: "array",
          items: { type: "string", enum: ["running", "stopping", "completed", "killed", "failed"] },
          description: "Only return these lifecycle states",
        },
        startedAfter: { type: "number", description: "Inclusive Unix timestamp in milliseconds" },
        startedBefore: { type: "number", description: "Inclusive Unix timestamp in milliseconds" },
        updatedAfter: { type: "number", description: "Inclusive Unix timestamp in milliseconds" },
        updatedBefore: { type: "number", description: "Inclusive Unix timestamp in milliseconds" },
        includeFinished: { type: "boolean", default: true },
        limit: { type: "number", minimum: 1, default: DEFAULT_JOB_LIST_LIMIT },
      },
    },
    async execute(input, context) {
      const host = resolveHost(context, port);
      if ("content" in host) return host;
      try {
        const limit = optionalNumber(input.limit) ?? DEFAULT_JOB_LIST_LIMIT;
        const listed = await host.jobs.list({
          sessionId: host.sessionId,
          ...optionalListFilters(input),
          limit,
        });
        return result("list", {
          ...listed,
          window: {
            limit,
            returned: listed.jobs.length,
            possiblyTruncated: listed.jobs.length === limit,
          },
        });
      } catch (error) {
        return failed(error);
      }
    },
  };

  const jobReadTool: ToolDefinition = {
    name: "JobRead",
    description: "Read output produced after an optional cursor and return the current job snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        target: targetProperty,
        after: { type: "number", description: "Cursor returned by an earlier JobRead or JobWait" },
        maxChars: { type: "number", default: 12000 },
      },
      required: ["target"],
    },
    async execute(input, context) {
      const host = resolveHost(context, port);
      if ("content" in host) return host;
      try {
        const read = await host.jobs.read({
          sessionId: host.sessionId,
          target: jobTarget(input.target),
          after: optionalNumber(input.after),
          maxChars: optionalNumber(input.maxChars),
        });
        return result("read", read);
      } catch (error) {
        return failed(error);
      }
    },
  };

  const jobWaitTool: ToolDefinition = {
    name: "JobWait",
    description: "Wait briefly for existing jobs without cancelling or restarting them. Defaults to 30 seconds, capped at 60 seconds and the remaining tool deadline. On expiry, returns current snapshots with timedOut=true; this is not a job failure. Use JobRead to inspect output or wait again if still running.",
    inputSchema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: { type: "object", properties: { target: targetProperty, after: { type: "number" } }, required: ["target"] },
          minItems: 1,
          maxItems: MAX_JOB_WAIT_IDS,
          description: "Job ids to wait for concurrently",
        },
        timeoutSeconds: { type: "number", default: 30, description: "Requested wait in seconds. Values above 60 are shortened; a shorter execution deadline may reduce it further." },
        maxChars: { type: "number", default: 12000 },
      },
      required: ["targets"],
    },
    async execute(input, context) {
      const host = resolveHost(context, port);
      if ("content" in host) return host;
      try {
        const timeoutSeconds = optionalNumber(input.timeoutSeconds) ?? 30;
        if (timeoutSeconds <= 0) throw new Error("timeoutSeconds must be positive.");
        if (!Array.isArray(input.targets) || input.targets.length === 0 || input.targets.length > MAX_JOB_WAIT_IDS) throw new Error(`targets must contain 1 to ${MAX_JOB_WAIT_IDS} entries`);
        const targets = input.targets.map(value => { const item = value as Record<string, unknown>; return { target: jobTarget(item.target), after: optionalNumber(item.after) }; });
        let timeoutMs = Math.min(timeoutSeconds * 1_000, MAX_JOB_WAIT_MS);
        if (context.deadlineAt !== undefined) {
          const remainingMs = Math.max(0, context.deadlineAt - Date.now());
          // Reserve time for the host's final snapshot and returning the tool result.
          timeoutMs = Math.min(timeoutMs, Math.max(1, remainingMs - Math.min(1_000, remainingMs * 0.2)));
        }
        const results = await Promise.all(targets.map(async ({ target, after }) => {
          try {
            return {
              target,
              ...await host.jobs.wait({
                sessionId: host.sessionId,
                target,
                timeoutMs,
                ...(after !== undefined ? { after } : {}),
                maxChars: optionalNumber(input.maxChars),
                signal: context.abortSignal,
              }),
            };
          } catch (error) {
            return { target, error: error instanceof Error ? error.message : String(error) };
          }
        }));
        return result("wait", { timeoutSeconds: timeoutMs / 1_000, results });
      } catch (error) {
        return failed(error);
      }
    },
  };

  const jobSendTool: ToolDefinition = {
    name: "JobSend",
    description: "Send input to an interactive terminal or agent job that accepts input.",
    inputSchema: {
      type: "object",
      properties: { target: targetProperty, data: { type: "string" } },
      required: ["target", "data"],
    },
    async execute(input, context) {
      const host = resolveHost(context, port);
      if ("content" in host) return host;
      try {
        const target = jobTarget(input.target);
        const receipt = await host.jobs.send({ sessionId: host.sessionId, target, data: String(input.data ?? "") }, { ...(authorization ?? (context.agent?.tools ? { tools: context.agent.tools } : {})), ...(context.agent ? { parent: { ...context.agent.scope, limits: context.agent.limits, bindToolDispatch: context.agent.bindToolDispatch } } : {}) });
        return result("send", { target, ...(receipt ? { receipt } : {}) });
      } catch (error) {
        return failed(error);
      }
    },
  };

  const jobCancelTool: ToolDefinition = {
    name: "JobCancel",
    description: "Request cancellation of a job owned by this session.",
    inputSchema: {
      type: "object",
      properties: { target: targetProperty, reason: { type: "string" } },
      required: ["target"],
    },
    async execute(input, context) {
      const host = resolveHost(context, port);
      if ("content" in host) return host;
      try {
        const snapshot = await host.jobs.cancel({
          sessionId: host.sessionId,
          target: jobTarget(input.target),
          ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
        });
        return result("cancel", { snapshot });
      } catch (error) {
        return failed(error);
      }
    },
  };

  const jobTools = [jobListTool, jobReadTool, jobWaitTool, jobSendTool, jobCancelTool];

  return jobTools;
}


function resolveHost(context: ToolContext, host?: AgentJobHost): { jobs: AgentJobHost; sessionId: string } | ToolResult {
  const jobs = host;
  if (!jobs) return failed("This host does not provide background jobs.");
  if (!context.sessionId) return failed("Background jobs require a durable session.");
  return { jobs, sessionId: context.sessionId };
}

function result(action: string, value: object): ToolResult {
  const job = value as { jobId?: string; cursor?: number; snapshot?: { id?: string; status?: string; exitCode?: number | null }; results?: Array<{ jobId: string; cursor?: number; snapshot?: { id?: string; status?: string; exitCode?: number | null } }> };
  const all = job.results ?? (job.snapshot?.id ? [job] : []);
  const snapshots = all.filter((item) => item.snapshot?.id);
  const withoutSnapshot = all.length - snapshots.length;
  const facts: string[] = [];
  for (const item of snapshots.slice().reverse()) {
    if (facts.length === 8) break;
    const id = item.snapshot!.id!;
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) continue;
    const fact = [
      `jobId=${id}`,
      item.snapshot?.status ? `status=${item.snapshot.status}` : undefined,
      item.cursor !== undefined ? `cursor=${item.cursor}` : undefined,
      item.snapshot?.exitCode !== undefined ? `exitCode=${item.snapshot.exitCode}` : undefined,
    ].filter(Boolean).join("; ");
    if (`Job${action} completed: ${[fact, ...facts].join(" | ")}`.length > 900) continue;
    facts.unshift(fact);
  }
  const omitted = snapshots.length - facts.length;
  const summary = [
    `Job${action} completed`,
    ...(withoutSnapshot ? [`${withoutSnapshot} observation without snapshot`] : []),
    ...(omitted ? [`${omitted} observation omitted from summary`] : []),
    ...facts,
  ].join("; ");
  return {
    content: [{ type: "text", text: JSON.stringify({ kind: "job", action, ...value }) }],
    executionState: "completed",
    compactSummary: summary,
  };
}

function failed(error: unknown): ToolResult {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
    failureKind: "unknown_outcome",
    executionState: "unknown",
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalListFilters(input: Record<string, unknown>) {
  return {
    ...(Array.isArray(input.kinds) && input.kinds.length > 0
      ? { kinds: input.kinds as JobKind[] }
      : {}),
    ...(Array.isArray(input.statuses) && input.statuses.length > 0
      ? { statuses: input.statuses as JobStatus[] }
      : {}),
    ...(optionalNumber(input.startedAfter) !== undefined ? { startedAfter: optionalNumber(input.startedAfter) } : {}),
    ...(optionalNumber(input.startedBefore) !== undefined ? { startedBefore: optionalNumber(input.startedBefore) } : {}),
    ...(optionalNumber(input.updatedAfter) !== undefined ? { updatedAfter: optionalNumber(input.updatedAfter) } : {}),
    ...(optionalNumber(input.updatedBefore) !== undefined ? { updatedBefore: optionalNumber(input.updatedBefore) } : {}),
    ...(typeof input.includeFinished === "boolean" ? { includeFinished: input.includeFinished } : {}),
    ...(optionalNumber(input.limit) !== undefined ? { limit: optionalNumber(input.limit) } : {}),
  };
}
