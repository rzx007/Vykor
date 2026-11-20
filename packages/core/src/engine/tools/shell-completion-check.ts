import { randomUUID } from "node:crypto";
import type { MutableToolRegistry, ToolExecutionResult, ToolUseBlock } from "@vykor/agent-contracts";

const COMPLETION_CHECK_TIMEOUT_MS = 60_000;

export function createCompletionCheckCall(
  registry: Pick<MutableToolRegistry, "inspect">,
  command: string,
): ToolUseBlock {
  if (registry.inspect("Shell")?.source.kind !== "builtin") {
    throw new Error("当前运行无法使用内置 Shell，未完成验收");
  }
  return {
    type: "tool_use",
    id: `call_${randomUUID().replaceAll("-", "")}`,
    name: "Shell",
    input: { command, timeout: COMPLETION_CHECK_TIMEOUT_MS },
  };
}

export function completionCheckFailure(
  result: ToolExecutionResult,
): { message: string; repairable: boolean } | undefined {
  const exitCode = result.metadata?.exitCode;
  if (result.executionState !== "completed" || typeof exitCode !== "number") {
    throw new Error("验收命令未取得退出码，请查看 Shell 结果");
  }
  if (!result.isError && exitCode === 0) return undefined;
  return {
    message: `验收未通过（退出码 ${exitCode}），请查看 Shell 结果`,
    repairable: result.failureKind === "command",
  };
}
