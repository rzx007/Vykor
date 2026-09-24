import type {
  AgentScheduleEffects,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@vykor/core";

function host(context: ToolContext): AgentScheduleEffects | undefined {
  return context.schedules;
}

function unavailable(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: "This host does not provide Agent scheduled tasks.",
      },
    ],
    isError: true,
  };
}

export const scheduleCreateTool: ToolDefinition = {
  name: "ScheduleCreate",
  description:
    "Create a persistent Agent task that runs once or on an RRULE schedule. Chat destinations inherit the current conversation runtime; model, effort, permissionProfile, and projectPaths are automatically ignored for chat tasks.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      prompt: {
        type: "string",
        description: "Durable instructions for every scheduled Agent run",
      },
      recurrence: {
        type: "string",
        description: "ISO timestamp for once, or RFC 5545 RRULE",
      },
      recurrenceFormat: { type: "string", enum: ["rrule", "once"] },
      timezone: { type: "string", description: "IANA timezone" },
      destination: {
        type: "string",
        enum: ["standalone", "chat"],
        description:
          "Use chat to run in and return to the current conversation; use standalone for runtime overrides or worktree isolation",
      },
      projectPaths: { type: "array", items: { type: "string" } },
      executionMode: {
        type: "string",
        enum: ["local", "worktree"],
        default: "local",
      },
      model: { type: "string" },
      effort: { type: "string" },
      skillNames: { type: "array", items: { type: "string" } },
      pluginNames: { type: "array", items: { type: "string" } },
      permissionProfile: permissionProfileSchema(),
      overlapPolicy: { type: "string", enum: ["skip", "queue"] },
      missedRunPolicy: { type: "string", enum: ["skip", "run_once"] },
      stopPolicy: {
        type: "object",
        properties: {
          runOnce: { type: "boolean" },
          maxRuns: { type: "number" },
          stopWhenCompleted: { type: "boolean" },
          expiresAt: { type: "number" },
        },
      },
    },
    required: [
      "name",
      "prompt",
      "recurrence",
      "recurrenceFormat",
      "timezone",
      "destination",
    ],
  },
  async execute(input, context) {
    const schedules = host(context);
    if (!schedules) return unavailable();
    try {
      const destination = input.destination === "chat" ? "chat" : "standalone";
      const permissionProfile = parsePermissionProfile(input.permissionProfile);
      const task = await schedules.create({
        name: String(input.name ?? ""),
        prompt: String(input.prompt ?? ""),
        recurrence: String(input.recurrence ?? ""),
        recurrenceFormat: input.recurrenceFormat === "once" ? "once" : "rrule",
        timezone: String(input.timezone ?? "UTC"),
        destination,
        ...(destination === "chat" && context.sessionId
          ? { sessionId: context.sessionId }
          : {}),
        projectPaths:
          destination === "chat"
            ? []
            : Array.isArray(input.projectPaths)
              ? input.projectPaths.map(String)
              : [context.cwd],
        executionMode:
          input.executionMode === "worktree" ? "worktree" : "local",
        ...(destination === "standalone" && typeof input.model === "string"
          ? { model: input.model }
          : {}),
        ...(destination === "standalone" && typeof input.effort === "string"
          ? { effort: input.effort }
          : {}),
        ...(Array.isArray(input.skillNames)
          ? { skillNames: input.skillNames.map(String) }
          : {}),
        ...(Array.isArray(input.pluginNames)
          ? { pluginNames: input.pluginNames.map(String) }
          : {}),
        ...(destination === "standalone" && permissionProfile
          ? { permissionProfile }
          : {}),
        ...(input.overlapPolicy === "queue" || input.overlapPolicy === "skip"
          ? { overlapPolicy: input.overlapPolicy }
          : {}),
        ...(input.missedRunPolicy === "run_once" ||
        input.missedRunPolicy === "skip"
          ? { missedRunPolicy: input.missedRunPolicy }
          : {}),
        ...(input.stopPolicy && typeof input.stopPolicy === "object"
          ? { stopPolicy: input.stopPolicy as Record<string, never> }
          : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: `Scheduled '${task.name}' (${task.id}); next run ${task.nextRunAt ? new Date(task.nextRunAt).toISOString() : "not scheduled"}.`,
          },
        ],
      };
    } catch (error) {
      return failed(error);
    }
  },
};

export const scheduleListTool: ToolDefinition = {
  name: "ScheduleList",
  description: "List persistent Agent scheduled tasks.",
  inputSchema: { type: "object", properties: {} },
  async execute(_input, context) {
    const schedules = host(context);
    if (!schedules) return unavailable();
    try {
      const tasks = await schedules.list();
      return {
        content: [
          {
            type: "text",
            text:
              tasks.length === 0
                ? "No Agent scheduled tasks configured."
                : tasks
                    .map(
                      (task) =>
                        `${task.id} ${task.name} [${task.status}] ${task.recurrence}`,
                    )
                    .join("\n"),
          },
        ],
      };
    } catch (error) {
      return failed(error);
    }
  },
};

export const scheduleUpdateTool: ToolDefinition = {
  name: "ScheduleUpdate",
  description: "Update, pause, resume, or complete an Agent scheduled task.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      prompt: { type: "string" },
      recurrence: { type: "string" },
      recurrenceFormat: { type: "string", enum: ["rrule", "once"] },
      timezone: { type: "string" },
      status: { type: "string", enum: ["active", "paused", "completed"] },
      model: { type: "string" },
      effort: { type: "string" },
      skillNames: { type: "array", items: { type: "string" } },
      pluginNames: { type: "array", items: { type: "string" } },
      permissionProfile: permissionProfileSchema(),
      overlapPolicy: { type: "string", enum: ["skip", "queue"] },
      missedRunPolicy: { type: "string", enum: ["skip", "run_once"] },
    },
    required: ["id"],
  },
  async execute(input, context) {
    const schedules = host(context);
    if (!schedules) return unavailable();
    try {
      const patch = Object.fromEntries(
        [
          "name",
          "prompt",
          "recurrence",
          "recurrenceFormat",
          "timezone",
          "status",
          "model",
          "effort",
          "skillNames",
          "pluginNames",
          "permissionProfile",
          "overlapPolicy",
          "missedRunPolicy",
        ]
          .filter((key) => input[key] !== undefined)
          .map((key) => [key, input[key]]),
      );
      const task = await schedules.update(String(input.id ?? ""), patch);
      return {
        content: [
          { type: "text", text: `Updated '${task.name}' (${task.status}).` },
        ],
      };
    } catch (error) {
      return failed(error);
    }
  },
};

export const scheduleDeleteTool: ToolDefinition = {
  name: "ScheduleDelete",
  description: "Delete an Agent scheduled task and its run projections.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  async execute(input, context) {
    const schedules = host(context);
    if (!schedules) return unavailable();
    try {
      await schedules.remove(String(input.id ?? ""));
      return {
        content: [
          { type: "text", text: `Deleted scheduled task '${input.id}'.` },
        ],
      };
    } catch (error) {
      return failed(error);
    }
  },
};

export const scheduleRunNowTool: ToolDefinition = {
  name: "ScheduleRunNow",
  description: "Run an Agent scheduled task immediately.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  async execute(input, context) {
    const schedules = host(context);
    if (!schedules) return unavailable();
    try {
      const run = await schedules.trigger(String(input.id ?? ""));
      return {
        content: [
          {
            type: "text",
            text: run.summary ?? run.error ?? `Scheduled run ${run.status}.`,
          },
        ],
        ...(run.status !== "succeeded" ? { isError: true } : {}),
      };
    } catch (error) {
      return failed(error);
    }
  },
};

function failed(error: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

type ScheduledPermissionProfile = NonNullable<
  Parameters<AgentScheduleEffects["create"]>[0]["permissionProfile"]
>;

function permissionProfileSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["read_only", "workspace_write", "full_access"],
      },
      network: { type: "boolean" },
      allowedTools: { type: "array", items: { type: "string" } },
      deniedTools: { type: "array", items: { type: "string" } },
    },
    required: ["mode"],
  };
}

function parsePermissionProfile(
  value: unknown,
): ScheduledPermissionProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const input = value as Record<string, unknown>;
  const mode = input.mode;
  if (
    mode !== "read_only" &&
    mode !== "workspace_write" &&
    mode !== "full_access"
  ) {
    return undefined;
  }
  return {
    mode,
    ...(typeof input.network === "boolean" ? { network: input.network } : {}),
    ...(Array.isArray(input.allowedTools)
      ? { allowedTools: input.allowedTools.map(String) }
      : {}),
    ...(Array.isArray(input.deniedTools)
      ? { deniedTools: input.deniedTools.map(String) }
      : {}),
  };
}
