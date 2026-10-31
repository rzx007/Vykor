import type {
  AgentExecutionContext,
  AgentPermissionDecision,
  AgentPermissionRequest,
  MutableToolRegistry,
  PermissionChecker,
} from "@vykor/agent-contracts";
import { requestPermissionDecision } from "./query-tool-permissions";

/** Sub-operation approvals use the same session policy as model-issued calls. */
export async function requestToolPermission(
  request: AgentPermissionRequest,
  options: {
    permissionChecker: PermissionChecker;
    toolRegistry: MutableToolRegistry;
    execution?: AgentExecutionContext;
    signal?: AbortSignal;
  },
): Promise<AgentPermissionDecision> {
  const { execution, toolRegistry, permissionChecker } = options;
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    ...(execution ? [execution.scope.signal] : []),
  ]);
  signal.throwIfAborted();
  const toolName = request.toolName;
  const binding = execution?.tools?.get(toolName);
  const definition = execution ? binding?.definition : toolRegistry.get(toolName);
  if (!definition) return { status: "denied", reason: `Unknown or disallowed permission target: ${toolName}` };
  // Capture the operation before awaiting policy; neither the source nor schema
  // may come from a tool's self-reported permission request.
  const captured: AgentPermissionRequest = {
    toolName,
    confirmation: "once",
    toolSource: binding?.source?.kind ?? toolRegistry.inspect(toolName)?.source.kind ?? "unknown",
    toolDescription: definition.description,
    reason: request.reason,
    input: structuredClone(request.input ?? {}),
  };
  let decision;
  try {
    decision = await permissionChecker.checkTool(toolName, captured.input!, definition.inputSchema, {
      requireConfirmation: true,
    });
  } catch {
    return { status: "denied", reason: "Permission check failed" };
  }
  signal.throwIfAborted();
  if (decision.action === "deny") return { status: "denied", reason: decision.reason };
  if (decision.action === "allow") return { status: "approved", decision: "once", reason: decision.reason };
  return requestPermissionDecision(captured, execution && { ...execution, scope: { ...execution.scope, signal } });
}
