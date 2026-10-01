import { randomUUID } from "node:crypto";
import type { AgentExecutionContext, IPermissionChecker, IHookExecutor } from "../index";
import type { ToolExecutionResult } from "../types/tools";
import type { PreparedToolCall } from "./query-tool-preparation";

export async function authorizeToolCalls(
  readyForPermission: PreparedToolCall[],
  results: ToolExecutionResult[],
  permissionChecker: IPermissionChecker,
  hookExecutor: IHookExecutor,
  execution: AgentExecutionContext | undefined,
  internalTools: ReadonlySet<string>,
): Promise<PreparedToolCall[]> {
  // 并行检查所有工具的权限状态（单个 checkTool 抛错不应波及其他工具）
  const checks = await Promise.all(
    readyForPermission.map(async ({ toolUse }) => {
      if (internalTools.has(toolUse.name)) {
        return {
          action: "allow" as const,
          reason: "Trusted host-internal run tool",
        };
      }
      try {
        return await permissionChecker.checkTool(toolUse.name, toolUse.input);
      } catch {
        return { action: "deny" as const, reason: "permission check failed" };
      }
    }),
  );

  const executable: PreparedToolCall[] = [];

  for (let readyIndex = 0; readyIndex < readyForPermission.length; readyIndex++) {
    const { idx, toolUse, tool } = readyForPermission[readyIndex]!;
    const decision = checks[readyIndex]!;

    // 处理权限被直接拒绝的情况
    if (decision.action === "deny") {
      results[idx] = {
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content: [
          {
            type: "text" as const,
            text: `Permission denied: ${decision.reason ?? "not allowed"}`,
          },
        ],
        isError: true,
        failureKind: "permission",
        executionState: "not_started",
      };
      continue;
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
      if (!allowed) {
        results[idx] = {
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          content: [
            {
              type: "text" as const,
              text: `Permission denied by user: ${decision.reason ?? "not confirmed"}`,
            },
          ],
          isError: true,
          failureKind: "permission",
          executionState: "not_started",
        };
        continue;
      }
    }

    // 执行工具使用前的钩子，若被钩子拦截则终止执行（hook 本身抛错时放行，不阻断执行）
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
      results[idx] = {
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content: [
          {
            type: "text" as const,
            text: `Blocked by hook: ${hookResult.reason ?? "pre-tool hook blocked execution"}`,
          },
        ],
        isError: true,
        failureKind: "policy",
        executionState: "not_started",
      };
      continue;
    }

    executable.push({ idx, toolUse, tool });
  }

  return executable;
}
