import type { AgentExecutionContext } from "../types/runtime";
import type { HookExecutor as IHookExecutor } from "../types/hooks";
import type { PermissionChecker as IPermissionChecker } from "../types/permissions";
import type { Message, ToolUseBlock } from "../types/messages";
import type { ToolContext, ToolDefinition, ToolExecutionResult, ToolRegistry } from "../types/tools";
import { prepareToolCalls } from "./query-tool-preparation";
import { authorizeToolCall, emitToolLifecycle } from "./query-tool-permissions";
import { executeToolWithTimeout, ToolTimeoutError, toolExecutionTimeoutMs } from "./query-tool-limits";
import type { ToolFailureMemory } from "./tool-failure-memory";
import { defaultRecoveryHint, externalToolMetadata, toolFeedbackFields } from "./tool-result-feedback";

export interface CheckedToolExecutionOptions {
  toolUses: ToolUseBlock[];
  toolRegistry: ToolRegistry;
  messages?: readonly Message[];
  permissionChecker: IPermissionChecker;
  hookExecutor: IHookExecutor;
  signal?: AbortSignal;
  execution?: AgentExecutionContext;
  timeoutMs?: number;
  internalTools?: ReadonlySet<string>;
  failedToolCalls?: ToolFailureMemory;
  createToolContext(toolUse: ToolUseBlock, toolAttemptId: string): ToolContext;
  isTrustedSummary(toolUse: ToolUseBlock, definition: ToolDefinition): boolean;
}

export interface CheckedToolExecutionResult {
  results: ToolExecutionResult[];
  failure?: { error: unknown };
}

/** Shared checked pipeline; running tools retain their original cancellation context. */
export async function executeCheckedTools(options: CheckedToolExecutionOptions): Promise<CheckedToolExecutionResult> {
  const {
    toolUses, toolRegistry, messages = [], permissionChecker, hookExecutor,
    signal, execution, internalTools = new Set(), failedToolCalls,
    createToolContext, isTrustedSummary,
  } = options;
  const timeoutMs = toolExecutionTimeoutMs(options.timeoutMs);
  const { results, readyForPermission } = prepareToolCalls(toolUses, failedToolCalls, toolRegistry, messages);
  const batchController = new AbortController();
  const startSignal = AbortSignal.any([
    batchController.signal,
    ...(signal ? [signal] : []),
    ...(execution?.scope.signal ? [execution.scope.signal] : []),
  ]);
  let failure: { error: unknown } | undefined;
  const failBatch = (error: unknown) => {
    failure ??= { error };
    batchController.abort(error);
  };
  // Only approval/start work sees batch cancellation. Running tools retain the original context.
  const pendingExecution = execution ? {
    ...execution,
    scope: { ...execution.scope, signal: startSignal },
    emit: async (event: Parameters<AgentExecutionContext["emit"]>[0]) => {
      try { await execution.emit(event); }
      catch (error) { failBatch(error); throw error; }
    },
  } : undefined;

  const preparedByIndex = new Map(readyForPermission.map(call => [call.idx, call]));
  const groupTails = new Map<string, Promise<ToolExecutionResult>>();
  const executedIndexes = new Set<number>();
  const tasks = toolUses.map((toolUse, idx) => {
    const group = toolRegistry.get(toolUse.name)?.serialGroup;
    const previous = group ? groupTails.get(group) : undefined;
    const task = (async (): Promise<ToolExecutionResult> => {
      const toolAttemptId = `tool_attempt_${toolUse.id}_1`;
      let started = false;
      let result: ToolExecutionResult;
      try {
        if (previous) await emitToolLifecycle(pendingExecution, toolUse.id, "queued", "not_started");
        const predecessor = await previous;
        startSignal.throwIfAborted();
        if (predecessor && (predecessor.isError || predecessor.executionState === "unknown")) {
          result = {
            toolUseId: toolUse.id, toolName: toolUse.name, toolAttemptId,
            content: [{ type: "text", text: `Tool was not started because preceding call ${predecessor.toolUseId} in the same group failed or has an unknown outcome.` }],
            isError: true, failureKind: "policy", executionState: "not_started",
            metadata: { recoveryGuard: "serial_group_blocked" },
          };
        } else if (results[idx]) {
          result = results[idx]!;
        } else {
          const prepared = preparedByIndex.get(idx)!;
          const denied = await authorizeToolCall(
            prepared, permissionChecker, hookExecutor, pendingExecution, internalTools, startSignal,
          );
          if (denied) {
            result = denied;
          } else {
            const tool = prepared.tool;
            const context = createToolContext(toolUse, toolAttemptId);
            startSignal.throwIfAborted();
            await emitToolLifecycle(pendingExecution, toolUse.id, "running");
            startSignal.throwIfAborted();
            started = true;
            executedIndexes.add(idx);
            const returned = await executeToolWithTimeout(tool, toolUse.input, context, timeoutMs, signal);
            result = {
              content: returned.content,
              isError: returned.isError,
              ...toolFeedbackFields(returned),
              toolUseId: toolUse.id,
              toolName: toolUse.name,
              toolAttemptId,
              metadata: externalToolMetadata(returned.metadata),
              compactSummary: isTrustedSummary(toolUse, tool)
                ? toolFeedbackFields(returned).compactSummary : undefined,
            };
          }
        }
      } catch (error) {
        // Reliable emits already recorded their error, including concurrent user cancellation.
        // Exceptions from a running tool remain ordinary tool feedback.
        if (!started && !startSignal.aborted) failBatch(error);
        const failureKind =
          (started ? signal?.aborted : startSignal.aborted) ? "interrupted" as const
            : error instanceof ToolTimeoutError ? "timeout" as const : "unknown_outcome" as const;
        result = {
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          toolAttemptId,
          content: [{ type: "text", text: String(error) }],
          isError: true,
          failureKind,
          executionState: started ? "unknown" : "not_started",
        };
      }
      result.executionState ??= result.isError ? "unknown" : "completed";
      if (result.executionState === "unknown") result.isError = true;
      if (result.isError) {
        result.failureKind ??= "unknown_outcome";
        result.recoveryHint ??= defaultRecoveryHint(result);
        result.compactSummary = `Tool feedback data: kind=${result.failureKind}; execution=${result.executionState}`;
      }
      results[idx] = result;
      try {
        await emitToolLifecycle(pendingExecution, toolUse.id,
          result.executionState === "unknown" ? "unknown" : result.isError ? "failed" : "completed",
          result.executionState);
      } catch (error) {
        failBatch(error);
      }
      return result;
    })();
    if (group) groupTails.set(group, task);
    return task;
  });
  await Promise.all(tasks);

  // Post hooks do not replace results already returned during cancellation.
  for (const idx of executedIndexes) {
    const result = results[idx]!;
    if (signal?.aborted) break;
    try {
      await hookExecutor.execute("post_tool_use", { tool: result.toolName, result });
    } catch (error) {
      failBatch(error);
    }
  }

  return { results, failure };
}
