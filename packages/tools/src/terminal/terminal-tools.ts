import type { AgentTerminalHost } from "@vykor/terminal";
import type { ToolContext, ToolDefinition, ToolResult } from "@vykor/agent-contracts";

export function createTerminalTools(host?: AgentTerminalHost): ToolDefinition[] {
  const terminalOpenTool: ToolDefinition = {
    name: "TerminalOpen",
    description:
      "Open a visible terminal in this session's working directory. For dev servers and watchers, provide command to run the service directly: its exit then updates terminal status. Do not daemonize the command or detach its child process. Use JobRead/JobWait to inspect output, JobSend for input, and JobCancel to stop it, with the returned target. Without command, opens an interactive shell. Prefer Shell for short commands and BackgroundShellCreate for finite builds or installs.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Service command to run in the session directory. For a subdirectory, include the shell-appropriate cd in the command. Omit to open an interactive shell." },
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
      if (context.abortSignal?.aborted) return { ...failed("Terminal interrupted before starting."), failureKind: "interrupted", executionState: "not_started" };
      if (input.command !== undefined && (typeof input.command !== "string" || !input.command.trim())) {
        return { ...failed("command must be a non-empty string."), failureKind: "invalid_input", executionState: "not_started" };
      }
      const resolved = resolveHost(context, host);
      if ("content" in resolved) return resolved;
      const command = optionalString(input.command);
      try {
        const terminal = await resolved.host.open({
          sessionId: resolved.sessionId,
          cwd: context.environment?.workspace.hostRoot ?? context.cwd,
          name: optionalString(input.name) ?? (command ? command.slice(0, 80) : undefined),
          cols: optionalNumber(input.cols),
          rows: optionalNumber(input.rows),
          shell: optionalString(input.shell),
          ...(command ? { command } : {}),
        });
        return { ...terminalResult("open", { terminal, jobId: terminal.id, target: { kind: "terminal", jobId: terminal.id } }), executionState: "completed", compactSummary: `TerminalOpen completed: jobId=${terminal.id}` };
      } catch (error) {
        return { ...failed(error), failureKind: "unknown_outcome", executionState: "unknown" };
      }
    },
  };

  return [terminalOpenTool];
}


function resolveHost(
  context: ToolContext,
  host?: AgentTerminalHost,
):
  | { host: AgentTerminalHost; sessionId: string }
  | ToolResult {
  const terminal = host;
  if (!terminal)
    return failed("This host does not provide persistent terminals.");
  if (!context.sessionId)
    return failed("Persistent terminals require a durable session.");
  return { host: terminal, sessionId: context.sessionId };
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
