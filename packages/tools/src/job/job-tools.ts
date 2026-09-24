import type { ToolContext, ToolDefinition, ToolResult } from "@vykor/core";
import type { JobKind, JobStatus } from "@vykor/jobs";

const DEFAULT_JOB_LIST_LIMIT = 100;
const MAX_JOB_WAIT_IDS = 32;
const jobIdProperty = { type: "string", description: "Job id returned by a long-running tool or JobList" };

export const jobListTool: ToolDefinition = {
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
    const host = resolveHost(context);
    if ("content" in host) return host;
    try {
      const limit = optionalNumber(input.limit) ?? DEFAULT_JOB_LIST_LIMIT;
      const jobs = await host.jobs.list({
        sessionId: host.sessionId,
        ...optionalListFilters(input),
        limit,
      });
      return result("list", {
        jobs,
        window: {
          limit,
          returned: jobs.length,
          possiblyTruncated: jobs.length === limit,
        },
      });
    } catch (error) {
      return failed(error);
    }
  },
};

export const jobReadTool: ToolDefinition = {
  name: "JobRead",
  description: "Read output produced after an optional cursor and return the current job snapshot.",
  inputSchema: {
    type: "object",
    properties: {
      jobId: jobIdProperty,
      after: { type: "number", description: "Cursor returned by an earlier JobRead or JobWait" },
      maxChars: { type: "number", default: 12000 },
    },
    required: ["jobId"],
  },
  async execute(input, context) {
    const host = resolveHost(context);
    if ("content" in host) return host;
    try {
      const read = await host.jobs.read({
        sessionId: host.sessionId,
        jobId: requiredString(input.jobId, "jobId"),
        after: optionalNumber(input.after),
        maxChars: optionalNumber(input.maxChars),
      });
      return result("read", read);
    } catch (error) {
      return failed(error);
    }
  },
};

export const jobWaitTool: ToolDefinition = {
  name: "JobWait",
  description: "Wait for one or more jobs to finish without cancelling them, bounded by timeoutSeconds.",
  inputSchema: {
    type: "object",
    properties: {
      jobIds: {
        type: "array",
        items: jobIdProperty,
        minItems: 1,
        maxItems: MAX_JOB_WAIT_IDS,
        description: "Job ids to wait for concurrently",
      },
      after: {
        type: "object",
        additionalProperties: { type: "number" },
        description: "Per-job cursors returned by earlier JobRead or JobWait calls",
      },
      timeoutSeconds: { type: "number", default: 30 },
      maxChars: { type: "number", default: 12000 },
    },
    required: ["jobIds"],
  },
  async execute(input, context) {
    const host = resolveHost(context);
    if ("content" in host) return host;
    try {
      const timeoutSeconds = optionalNumber(input.timeoutSeconds) ?? 30;
      if (timeoutSeconds <= 0) throw new Error("timeoutSeconds must be positive.");
      if (Array.isArray(input.jobIds) && input.jobIds.length > MAX_JOB_WAIT_IDS) {
        throw new Error(`jobIds cannot contain more than ${MAX_JOB_WAIT_IDS} entries.`);
      }
      const jobIds = requiredStringArray(input.jobIds, "jobIds");
      const cursors = optionalCursorMap(input.after);
      const results = await Promise.all(jobIds.map(async (jobId) => {
        try {
          return {
            jobId,
            ...await host.jobs.wait({
              sessionId: host.sessionId,
              jobId,
              timeoutMs: timeoutSeconds * 1_000,
              ...(cursors?.[jobId] !== undefined ? { after: cursors[jobId] } : {}),
              maxChars: optionalNumber(input.maxChars),
              signal: context.abortSignal,
            }),
          };
        } catch (error) {
          return { jobId, error: error instanceof Error ? error.message : String(error) };
        }
      }));
      return result("wait", { results });
    } catch (error) {
      return failed(error);
    }
  },
};

export const jobSendTool: ToolDefinition = {
  name: "JobSend",
  description: "Send input to an interactive terminal or agent job that accepts input.",
  inputSchema: {
    type: "object",
    properties: { jobId: jobIdProperty, data: { type: "string" } },
    required: ["jobId", "data"],
  },
  async execute(input, context) {
    const host = resolveHost(context);
    if ("content" in host) return host;
    try {
      const jobId = requiredString(input.jobId, "jobId");
      const request = { sessionId: host.sessionId, jobId, data: String(input.data ?? "") };
      const authorization = context.capabilityView ?? context.agent?.capabilityView;
      if (authorization) await host.jobs.send(request, authorization);
      else await host.jobs.send(request);
      return result("send", { jobId });
    } catch (error) {
      return failed(error);
    }
  },
};

export const jobCancelTool: ToolDefinition = {
  name: "JobCancel",
  description: "Request cancellation of a job owned by this session.",
  inputSchema: {
    type: "object",
    properties: { jobId: jobIdProperty, reason: { type: "string" } },
    required: ["jobId"],
  },
  async execute(input, context) {
    const host = resolveHost(context);
    if ("content" in host) return host;
    try {
      const snapshot = await host.jobs.cancel({
        sessionId: host.sessionId,
        jobId: requiredString(input.jobId, "jobId"),
        ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
      });
      return result("cancel", { snapshot });
    } catch (error) {
      return failed(error);
    }
  },
};

export const jobTools = [jobListTool, jobReadTool, jobWaitTool, jobSendTool, jobCancelTool];

function resolveHost(context: ToolContext): { jobs: NonNullable<ToolContext["jobs"]>; sessionId: string } | ToolResult {
  if (!context.jobs) return failed("This host does not provide background jobs.");
  if (!context.sessionId) return failed("Background jobs require a durable session.");
  return { jobs: context.jobs, sessionId: context.sessionId };
}

function result(action: string, value: object): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ kind: "job", action, ...value }) }] };
}

function failed(error: unknown): ToolResult {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
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

function requiredStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must contain at least one job id.`);
  return [...new Set(value.map((item) => requiredString(item, name)))];
}

function optionalCursorMap(value: unknown): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("after must be an object keyed by job id.");
  }
  const cursors: Record<string, number> = {};
  for (const [jobId, cursor] of Object.entries(value)) {
    const parsed = optionalNumber(cursor);
    if (parsed === undefined) throw new Error(`after.${jobId} must be a finite number.`);
    cursors[jobId] = parsed;
  }
  return cursors;
}
