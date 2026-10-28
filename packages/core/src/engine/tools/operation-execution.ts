import type {
  AgentExecutionContext,
  AgentToolSafety,
  ToolDispatchReceipt,
  ToolOperationIntent,
  ToolOperationTicket,
  ToolUseBlock,
} from "@vykor/agent-contracts";

// A failed receipt write must also stop later SDK calls using this same host/run.
const persistenceFailures = new WeakMap<
  AgentToolSafety["operations"],
  Map<string, unknown>
>();
export class RequiredToolPolicyError extends Error {}

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) immutable(item);
    Object.freeze(value);
  }
  return value;
}

/** Snapshot only data; keep captured executable bindings and AbortSignal capabilities intact. */
export function operationIntent(
  execution: AgentExecutionContext,
  toolUse: ToolUseBlock,
  parentOperationId?: string,
  generationId?: string,
): ToolOperationIntent {
  const binding = execution.tools?.get(toolUse.name);
  return Object.freeze({
    scope: Object.freeze({ ...execution.scope }),
    toolUse: immutable(structuredClone(toolUse)),
    ...(generationId ? { generationId } : {}),
    ...(parentOperationId ? { parentOperationId } : {}),
    ...(binding
      ? {
          binding: Object.freeze({
            ...binding,
            source: binding.source
              ? immutable(structuredClone(binding.source))
              : undefined,
            definition: Object.freeze({
              ...binding.definition,
              inputSchema: immutable(
                structuredClone(binding.definition.inputSchema),
              ),
            }),
          }),
        }
      : {}),
  });
}

export function validateToolSafety(safety: AgentToolSafety): void {
  if (
    !safety ||
    !safety.operations ||
    !safety.requiredPolicy ||
    ["prepare", "authorize", "dispatch", "settle", "reject"].some(
      (name) =>
        typeof (safety.operations as unknown as Record<string, unknown>)[
          name
        ] !== "function",
    ) ||
    typeof safety.requiredPolicy.check !== "function"
  )
    throw new Error(
      "Tool safety requires both operation storage and required policy capabilities",
    );
}

/** Optional hooks never participate in this bounded, mandatory host check. */
export async function checkRequiredToolPolicy(
  safety: AgentToolSafety,
  intent: ToolOperationIntent,
  operation: ToolOperationTicket,
  phase: "authorization" | "dispatch",
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const timeoutMs =
    typeof safety.policyTimeoutMs === "number" &&
    Number.isFinite(safety.policyTimeoutMs) &&
    safety.policyTimeoutMs > 0
      ? safety.policyTimeoutMs
      : 5_000;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const verdict = await Promise.race([
      Promise.resolve().then(() =>
        safety.requiredPolicy.check({
          intent,
          operation: immutable(structuredClone(operation)),
          phase,
        }),
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new RequiredToolPolicyError(
                `Required tool policy timed out after ${timeoutMs} ms`,
              ),
            ),
          timeoutMs,
        );
        timeout.unref?.();
      }),
      new Promise<never>((_, reject) => {
        abort = () =>
          reject(signal?.reason ?? new Error("Tool authorization cancelled"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
    signal?.throwIfAborted();
    if (
      !verdict ||
      verdict.allowed !== true ||
      typeof verdict.policyVersion !== "string" ||
      !verdict.policyVersion.trim()
    )
      throw new RequiredToolPolicyError(
        verdict?.reason ??
          "Required tool policy denied execution or returned no policy version",
      );
    return verdict.policyVersion;
  } catch (error) {
    if (signal?.aborted || error instanceof RequiredToolPolicyError)
      throw error;
    throw new RequiredToolPolicyError(
      `Required tool policy failed: ${String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export function rememberToolPersistenceFailure(
  safety: AgentToolSafety,
  runId: string,
  error: unknown,
): void {
  let runs = persistenceFailures.get(safety.operations);
  if (!runs) persistenceFailures.set(safety.operations, (runs = new Map()));
  runs.set(runId, error);
}
export function assertToolOperationDispatchable(
  safety: AgentToolSafety,
  intent: ToolOperationIntent,
  operation: ToolOperationTicket,
): void {
  if (operation.state === "unknown" || operation.state === "dispatching")
    // A known dispatch refusal is policy feedback, not a broken execution host.
    throw new RequiredToolPolicyError(
      `Tool operation ${operation.operationId} has an unresolved outcome; dispatch is stopped`,
    );
  if (
    operation.kind !== "read_only" &&
    persistenceFailures.get(safety.operations)?.has(intent.scope.runId)
  )
    throw new Error(
      "Tool dispatch stopped because an earlier operation receipt could not be saved",
    );
  if (!["prepared", "authorized", "not_applied"].includes(operation.state))
    throw new Error(
      `Tool operation ${operation.operationId} cannot dispatch from ${operation.state}`,
    );
}

export interface ActiveToolOperation {
  safety: AgentToolSafety;
  intent: ToolOperationIntent;
  ticket: ToolOperationTicket;
  receipt?: ToolDispatchReceipt;
}
