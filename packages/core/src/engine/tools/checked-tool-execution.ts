import type {
  AgentExecutionContext,
  HookExecutor,
  PermissionChecker,
  Message,
  ToolUseBlock,
  MutableToolRegistry,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "@vykor/agent-contracts";
import {
  isAgentExecutionLimitError,
  parseMcpCallResultData,
  publicToolResult,
} from "@vykor/agent-contracts";
import { prepareToolCalls } from "./query-tool-preparation";
import { authorizeToolCall, emitToolLifecycle } from "./query-tool-permissions";
import {
  executeToolWithTimeout,
  ToolTimeoutError,
  toolExecutionTimeoutMs,
} from "./query-tool-limits";
import type { ToolFailureMemory } from "./tool-failure-memory";
import {
  defaultRecoveryHint,
  externalToolMetadata,
  toolFeedbackFields,
  validHostFileFacts,
} from "./tool-result-feedback";

export interface CheckedToolExecutionOptions {
  toolUses: ToolUseBlock[];
  toolRegistry: MutableToolRegistry;
  messages?: readonly Message[];
  permissionChecker: PermissionChecker;
  hookExecutor: HookExecutor;
  signal?: AbortSignal;
  /** Parent dispatch gate; stops new work without cancelling calls already running. */
  dispatchSignal?: AbortSignal;
  execution?: AgentExecutionContext;
  generationId?: string;
  timeoutMs?: number;
  internalTools?: ReadonlySet<string>;
  failedToolCalls?: ToolFailureMemory;
  /** Nested checked calls report host failures directly, even if a proxy catches their error. */
  onFatalFailure?(error: unknown): void;
  createToolContext(toolUse: ToolUseBlock, toolAttemptId: string, control: {
    reportFatalFailure(error: unknown): void;
    dispatchSignal: AbortSignal;
  }): ToolContext;
  isTrustedSummary(toolUse: ToolUseBlock, definition: ToolDefinition): boolean;
}
export interface CheckedToolExecutionResult {
  results: ToolExecutionResult[];
  /** Host/Run failure only. Tool errors, including unknown outcomes, stay in results. */
  fatalFailure?: { error: unknown };
}

class ToolPreflightError extends Error {}
async function validateBeforeDispatch(
  validate: NonNullable<import("@vykor/agent-contracts").AgentRunToolContribution["beforeDispatch"]>,
  input: Record<string, unknown>, context: ToolContext, signal: AbortSignal, timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const reason = await Promise.race([
      Promise.resolve().then(() => validate(input, context)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ToolPreflightError("Host validation timed out")), timeoutMs); timer.unref?.(); }),
      new Promise<never>((_, reject) => { abort = () => reject(signal.reason ?? new Error("Host validation cancelled")); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); }),
    ]);
    signal.throwIfAborted();
    if (reason) throw new ToolPreflightError(reason);
  } catch (error) {
    if (signal.aborted) throw error;
    throw error instanceof ToolPreflightError ? error : new ToolPreflightError(error instanceof Error ? error.message : "Host validation failed");
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function finishResult(result: ToolExecutionResult): ToolExecutionResult {
  result.executionState ??= "completed";
  if (result.executionState === "unknown") result.isError = true;
  if (result.isError) {
    result.hostFileFacts = undefined;
    if (result.executionState === "unknown") result.failureKind ??= "unknown_outcome";
    result.recoveryHint ??= defaultRecoveryHint(result);
    result.compactSummary = `Tool feedback data: kind=${result.failureKind}; execution=${result.executionState}`;
  }
  return result;
}

/** One path for model, explicit, and nested calls; host dispatch checks run after ordinary permission. */
export async function executeCheckedTools(
  options: CheckedToolExecutionOptions,
): Promise<CheckedToolExecutionResult> {
  const {
    toolUses,
    toolRegistry,
    messages = [],
    permissionChecker,
    hookExecutor,
    signal,
    execution,
    internalTools = new Set(),
    failedToolCalls,
    createToolContext,
    isTrustedSummary,
  } = options;
  const timeoutMs = toolExecutionTimeoutMs(options.timeoutMs);
  const { results, readyForPermission } = prepareToolCalls(
    toolUses,
    failedToolCalls,
    toolRegistry,
    messages,
  );
  if (toolUses.length > 1) for (let index = readyForPermission.length - 1; index >= 0; index--) {
    const item = readyForPermission[index]!;
    const exclusive = execution?.contribution?.tools?.some(contribution => contribution.definition === item.tool && contribution.requiresSoloBatch === true);
    if (exclusive) {
      results[item.idx] = { toolUseId: item.toolUse.id, toolName: item.toolUse.name, content: [{ type: "text", text: "Submit this finalization tool alone after the other calls have settled." }], isError: true, executionState: "not_started", failureKind: "invalid_input" };
      readyForPermission.splice(index, 1);
    }
  }
  const batchController = new AbortController();
  const startSignal = AbortSignal.any([
    batchController.signal,
    ...(options.dispatchSignal ? [options.dispatchSignal] : []),
    ...(signal ? [signal] : []),
    ...(execution?.scope.signal ? [execution.scope.signal] : []),
  ]);
  const runningSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    ...(execution?.scope.signal ? [execution.scope.signal] : []),
  ]);
  let fatalFailure: { error: unknown } | undefined;
  const failExecution = (error: unknown) => {
    if (fatalFailure) return;
    fatalFailure = { error };
    batchController.abort(error);
    options.onFatalFailure?.(error);
  };
  const control = { reportFatalFailure: failExecution, dispatchSignal: startSignal };
  const pendingExecution = execution
    ? {
        ...execution,
        scope: { ...execution.scope, signal: startSignal },
        emit: async (event: Parameters<AgentExecutionContext["emit"]>[0]) => {
          try {
            await execution.emit(event);
          } catch (error) {
            failExecution(error);
            throw error;
          }
        },
      }
    : undefined;
  const preparedByIndex = new Map(
    readyForPermission.map((call) => [call.idx, call]),
  );
  const groupTails = new Map<string, Promise<ToolExecutionResult>>();
  const executedIndexes = new Set<number>();
  const changesMode = readyForPermission.some(
    ({ tool }) => tool.serialGroup === "permission-mode",
  );
  const tasks = toolUses.map((originalUse, idx) => {
    const group = changesMode
      ? "permission-mode"
      : toolRegistry.get(originalUse.name)?.serialGroup;
    const previous = group ? groupTails.get(group) : undefined;
    const task = (async (): Promise<ToolExecutionResult> => {
      let toolUse = originalUse;
      const toolAttemptId = `tool_attempt_${toolUse.id}_1`;
      let started = false;
      let result: ToolExecutionResult;
      const identity = () => ({ toolAttemptId, ...(options.generationId ? { generationId: options.generationId } : {}) });
      const returnedResult = (
        returned: Awaited<ReturnType<ToolDefinition["execute"]>>,
        tool: ToolDefinition,
      ) => {
        if (!returned || !Array.isArray(returned.content))
          throw new Error("Tool returned malformed content");
        const normalized = {
          content: returned.content,
          isError: returned.isError,
          ...(returned.mcpResult !== undefined
            ? { mcpResult: parseMcpCallResultData(returned.mcpResult) }
            : {}),
          ...toolFeedbackFields(returned),
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          toolAttemptId,
          metadata: externalToolMetadata(returned.metadata),
          hostFileFacts:
            isTrustedSummary(toolUse, tool) && !returned.isError
              ? validHostFileFacts(returned.metadata?.hostFileFacts)
              : undefined,
          compactSummary: isTrustedSummary(toolUse, tool)
            ? toolFeedbackFields(returned).compactSummary
            : undefined,
        } satisfies ToolExecutionResult;
        // Only the checked host can prove a dispatched tool was never invoked.
        if (normalized.executionState === "not_started") normalized.executionState = "unknown";
        return finishResult(normalized);
      };
      try {
        if (previous)
          await emitToolLifecycle(
            pendingExecution,
            toolUse.id,
            "queued",
            "not_started",
            identity(),
          );
        const predecessor = await previous;
        startSignal.throwIfAborted();
        if (
          predecessor &&
          (predecessor.isError || predecessor.executionState === "unknown")
        ) {
          result = {
            toolUseId: toolUse.id,
            toolName: toolUse.name,
            toolAttemptId,
            content: [
              {
                type: "text",
                text: `Tool was not started because preceding call ${predecessor.toolUseId} in the same group failed or has an unknown outcome.`,
              },
            ],
            isError: true,
            failureKind: "policy",
            executionState: "not_started",
            metadata: { recoveryGuard: "serial_group_blocked" },
          };
        } else if (results[idx]) result = results[idx]!;
        else {
          const prepared = preparedByIndex.get(idx)!;
          toolUse = prepared.toolUse;
          const denied = await authorizeToolCall(
            prepared,
            permissionChecker,
            hookExecutor,
            pendingExecution,
            internalTools,
            startSignal,
            identity(),
          );
          if (denied) result = denied;
          else {
            const tool = prepared.tool;
            startSignal.throwIfAborted();
            await execution?.limits?.check("tool", {
              toolName: tool.name,
              toolAttemptId,
            });
            startSignal.throwIfAborted();
            const preflight = execution?.contribution?.tools?.find(item => item.definition === tool)?.beforeDispatch;
            if (preflight) await validateBeforeDispatch(preflight, toolUse.input, createToolContext(toolUse, toolAttemptId, control), startSignal, timeoutMs);
            const context = createToolContext(toolUse, toolAttemptId, control);
            await emitToolLifecycle(
              pendingExecution,
              toolUse.id,
              "running",
              undefined,
              identity(),
            );
            startSignal.throwIfAborted();
            if (execution?.checkToolDispatch) {
              try {
                await validateBeforeDispatch(async () => {
                  await execution.checkToolDispatch!({ scope: execution.scope, toolUse, binding: execution.tools?.get(toolUse.name), cwd: context.cwd });
                  return undefined;
                }, toolUse.input, context, startSignal, timeoutMs);
              } catch (error) { failExecution(error); throw error; }
            }
            startSignal.throwIfAborted();
            started = true;
            executedIndexes.add(idx);
            const returned = await executeToolWithTimeout(
              tool,
              toolUse.input,
              context,
              timeoutMs,
              runningSignal,
              settled => {
                try {
                  execution?.observeInvocation?.(settled);
                } catch (error) {
                  failExecution(error);
                  throw error;
                }
              },
            );
            result = returnedResult(returned, tool);
          }
        }
      } catch (error) {
        if (isAgentExecutionLimitError(error)) failExecution(error);
        if (
          !started &&
          !startSignal.aborted &&
          !(error instanceof ToolPreflightError)
        )
          failExecution(error);
        result = {
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          toolAttemptId,
          content: [{ type: "text", text: String(error) }],
          isError: true,
          failureKind: (started ? runningSignal.aborted : startSignal.aborted)
            ? "interrupted"
            : error instanceof ToolPreflightError
              ? "invalid_input"
              : error instanceof ToolTimeoutError
                ? "timeout"
                : "unknown_outcome",
          executionState:
            started
              ? "unknown"
              : "not_started",
        };
      }
      result = finishResult(result!);
      if (!started) delete result.toolAttemptId;
      results[idx] = result;
      try {
        await emitToolLifecycle(
          pendingExecution,
          toolUse.id,
          result.executionState === "unknown"
            ? "unknown"
            : result.isError
              ? "failed"
              : "completed",
          result.executionState,
          identity(),
        );
      } catch (error) {
        failExecution(error);
      }
      return result;
    })();
    if (group) groupTails.set(group, task);
    return task;
  });
  await Promise.all(tasks);
  for (const idx of executedIndexes) {
    const result = results[idx]!;
    if (signal?.aborted || execution?.profile?.executableHooks === false) break;
    try {
      await hookExecutor.execute("post_tool_use", {
        tool: result.toolName,
        result: publicToolResult(result),
      });
    } catch (error) {
      failExecution(error);
    }
  }
  return { results, fatalFailure };
}
