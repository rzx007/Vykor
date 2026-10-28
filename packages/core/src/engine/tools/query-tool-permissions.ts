import { randomUUID } from "node:crypto";
import type {
  AgentExecutionContext,
  PermissionChecker as IPermissionChecker,
  HookExecutor as IHookExecutor,
} from "@vykor/agent-contracts";
import type { ToolExecutionResult } from "@vykor/agent-contracts";
import type { PreparedToolCall } from "./query-tool-preparation";

interface ToolLifecycleIdentity {
  generationId?: string;
  toolAttemptId?: string;
}

export async function authorizeToolCall(
  { toolUse, tool }: PreparedToolCall,
  permissionChecker: IPermissionChecker,
  hookExecutor: IHookExecutor,
  execution: AgentExecutionContext | undefined,
  internalTools: ReadonlySet<string>,
  signal?: AbortSignal,
  identity?: ToolLifecycleIdentity,
): Promise<ToolExecutionResult | undefined> {
  signal?.throwIfAborted();
  let decision;
  try {
    decision = internalTools.has(toolUse.name)
      ? { action: "allow" as const, reason: "Trusted host-internal run tool" }
      : await permissionChecker.checkTool(
          toolUse.name,
          toolUse.input,
          tool.inputSchema,
        );
  } catch {
    decision = { action: "deny" as const, reason: "permission check failed" };
  }
  signal?.throwIfAborted();

  // 处理权限被直接拒绝的情况
  if (decision.action === "deny") {
    return {
      toolUseId: toolUse.id,
      toolName: toolUse.name,
      content: [
        {
          type: "text",
          text: `Permission denied: ${decision.reason ?? "not allowed"}`,
        },
      ],
      isError: true,
      failureKind: "permission",
      executionState: "not_started",
    };
  }


  // 处理需要用户确认权限的情况
  const binding = execution?.tools?.get(toolUse.name);
  const confirmed =
    decision.action === "ask" && execution && binding
      ? (await execution.confirmTool?.({
          toolUse,
          binding,
          scope: execution.scope,
        })) === true
      : false;
  if (decision.action === "ask" && !confirmed) {
    let allowed = false;
    if (execution) {
      const requestId = `permission_${randomUUID()}`;
      const request = {
        toolName: toolUse.name,
        toolSource:
          execution.tools?.get(toolUse.name)?.source?.kind ?? "unknown",
        toolDescription: tool.description,
        reason: decision.reason,
        input: toolUse.input,
      };
      await emitToolLifecycle(
        execution,
        toolUse.id,
        "waiting_permission",
        "not_started",
        identity,
      );
      await execution.emit({
        type: "permission.requested",
        data: { requestId, request },
      });
      const approval = await execution.effects.requestPermission(
        request,
        execution.scope,
      );
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
        content: [
          {
            type: "text",
            text: `Permission denied by user: ${decision.reason ?? "not confirmed"}`,
          },
        ],
        isError: true,
        failureKind: "permission",
        executionState: "not_started",
      };
    }
  }

  if (execution?.profile?.executableHooks === false) return;

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
      content: [
        {
          type: "text",
          text: `Blocked by hook: ${hookResult.reason ?? "pre-tool hook blocked execution"}`,
        },
      ],
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
  phase:
    | "preparing"
    | "waiting_permission"
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "unknown",
  executionState?: import("@vykor/agent-contracts").ToolExecutionState,
  identity?: ToolLifecycleIdentity,
): Promise<void> {
  await execution?.emit({
    type: "domain.event",
    data: {
      name: "tool.lifecycle",
      payload: {
        toolUseId,
        ...(identity ? identity : { toolAttemptId: `tool_attempt_${toolUseId}_1` }),
        phase,
        ...(executionState ? { executionState } : {}),
      },
    },
  });
}
