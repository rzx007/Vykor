import type { ToolContext, ToolDefinition } from "@vykor/agent-contracts";
import { readToolOutputPolicy } from "@vykor/host-config";
import type { FileToolHost, ShellToolHost } from "../src/ports/policy.js";

/** Existing fixture facts are supplied to the factory before tool execution. */
export function executeToolFixture(
  factory: (host: FileToolHost & ShellToolHost) => ToolDefinition,
  input: Record<string, unknown>,
  fixture: ToolContext & Partial<FileToolHost & ShellToolHost>,
) {
  const { settings, shellOutputLogs, backgroundShell, ...context } = fixture;
  return factory({
    settings,
    shellOutputLogs,
    backgroundShell,
    outputPolicy: readToolOutputPolicy(),
  }).execute(input, context);
}
