import { WebProviderError } from "./types.js";
import type { ToolResult } from "@vykor/core";

export function webErrorFacts(error: unknown): Pick<ToolResult, "failureKind" | "executionState" | "recoveryHint"> {
  if (error instanceof WebProviderError) {
    if (error.code === "invalid_request") return { failureKind: "invalid_input", executionState: "not_started", recoveryHint: "检查网址或查询参数后再调用。" };
    if (error.code === "aborted") return { failureKind: "interrupted", executionState: "unknown", recoveryHint: "先检查请求是否已经产生结果。" };
    if (error.code === "provider_unavailable") return { failureKind: "provider", executionState: "not_started", recoveryHint: "检查网页服务是否可用。" };
  }
  return { failureKind: "provider", executionState: "unknown", recoveryHint: "检查网页服务和实际访问条件；结果不确定时先核实状态。" };
}

export function formatWebError(toolName: "web_search" | "web_fetch", error: unknown): string {
  if (error instanceof WebProviderError) {
    return `${toolName} failed [${error.code}]: ${error.message}`;
  }
  return `${toolName} failed [unknown]: ${error instanceof Error ? error.message : String(error)}`;
}
