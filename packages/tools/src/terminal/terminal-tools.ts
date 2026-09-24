import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@vykor/core";

export const terminalOpenTool: ToolDefinition = {
  name: "TerminalOpen",
  description:
    "Open a persistent interactive terminal in this session's working directory. Prefer Shell for a single non-interactive command; use this for long-running or interactive processes.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Short label shown in the terminal panel",
      },
      cols: {
        type: "number",
        description: "Initial terminal columns",
        default: 100,
      },
      rows: {
        type: "number",
        description: "Initial terminal rows",
        default: 30,
      },
      shell: { type: "string", description: "Optional shell executable" },
    },
  },
  async execute(input, context) {
    const resolved = resolveHost(context);
    if ("content" in resolved) return resolved;
    try {
      const terminal = await resolved.host.open({
        sessionId: resolved.sessionId,
        cwd: context.cwd,
        name: optionalString(input.name),
        cols: optionalNumber(input.cols),
        rows: optionalNumber(input.rows),
        shell: optionalString(input.shell),
      });
      return terminalResult("open", { terminal });
    } catch (error) {
      return failed(error);
    }
  },
};

export const terminalTools = [terminalOpenTool];

function resolveHost(
  context: ToolContext,
):
  | { host: NonNullable<ToolContext["terminal"]>; sessionId: string }
  | ToolResult {
  if (!context.terminal)
    return failed("This host does not provide persistent terminals.");
  if (!context.sessionId)
    return failed("Persistent terminals require a durable session.");
  return { host: context.terminal, sessionId: context.sessionId };
}

function terminalResult(
  action: string,
  value: Record<string, unknown>,
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ kind: "terminal", action, ...value }),
      },
    ],
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

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
