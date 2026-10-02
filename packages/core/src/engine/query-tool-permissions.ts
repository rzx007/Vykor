import { randomUUID } from "node:crypto";
import type { AgentExecutionContext, IPermissionChecker, IHookExecutor } from "../index";
import type { ToolExecutionResult } from "../types/tools";
import type { PreparedToolCall } from "./query-tool-preparation";

export async function authorizeToolCall(
  { toolUse, tool }: PreparedToolCall,
  permissionChecker: IPermissionChecker,
  hookExecutor: IHookExecutor,
  execution: AgentExecutionContext | undefined,
  internalTools: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult | undefined> {
  signal?.throwIfAborted();
  let decision;
  try {
    decision = internalTools.has(toolUse.name)
      ? { action: "allow" as const, reason: "Trusted host-internal run tool" }
      : await permissionChecker.checkTool(toolUse.name, toolUse.input, tool.inputSchema);
  } catch {
    decision = { action: "deny" as const, reason: "permission check failed" };
  }
  signal?.throwIfAborted();

  // 处理权限被直接拒绝的情况
  if (decision.action === "deny") {
    return {
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      content: [{ type: "text", text: `Permission denied: ${decision.reason ?? "not allowed"}` }],
      isError: true,
      failureKind: "permission",
      executionState: "not_started",
    };
  }

  // 处理需要用户确认权限的情况
  if (decision.action === "ask") {
    let allowed = false;
    if (execution) {
      const requestId = `permission_${randomUUID()}`;
      const request = {
        toolName: toolUse.name,
        reason: decision.reason,
        input: toolUse.input,
      };
      await emitToolLifecycle(execution, toolUse.id, "waiting_permission", "not_started");
      await execution.emit({
        type: "permission.requested",
        data: { requestId, request },
      });
      const approval = await execution.effects.requestPermission(request, execution.scope);
      await execution.emit({
        type: "permission.resolved",
        data: { requestId, decision: approval },
      });
      allowed = approval.status === "approved";
    }
    signal?.throwIfAborted();
    if (!allowed) {
      return {
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content: [{ type: "text", text: `Permission denied by user: ${decision.reason ?? "not confirmed"}` }],
        isError: true,
        failureKind: "permission",
        executionState: "not_started",
      };
    }
  }

  // hook 本身抛错时放行，不阻断执行。
  let hookResult: { blocked: boolean; reason?: string };
  try {
    hookResult = await hookExecutor.execute("pre_tool_use", {
      tool: toolUse.name,
      input: toolUse.input,
    });
  } catch {
    hookResult = { blocked: false };
  }

  if (hookResult.blocked) {
    return {
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      content: [{ type: "text", text: `Blocked by hook: ${hookResult.reason ?? "pre-tool hook blocked execution"}` }],
      isError: true,
      failureKind: "policy",
      executionState: "not_started",
    };
  }
  signal?.throwIfAborted();
}

/** Host facts only; a stage event never authorizes or commits a tool result. */
export async function emitToolLifecycle(
  execution: AgentExecutionContext | undefined,
  toolUseId: string,
  phase: "preparing" | "waiting_permission" | "queued" | "running" | "completed" | "failed" | "unknown",
  executionState?: import("../types/tools").ToolExecutionState,
): Promise<void> {
  await execution?.emit({ type: "domain.event", data: { name: "tool.lifecycle", payload: {
    toolUseId, toolAttemptId: `tool_attempt_${toolUseId}_1`, phase,
    ...(executionState ? { executionState } : {}),
  } } });
}
