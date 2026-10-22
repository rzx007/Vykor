import type { AgentSerializedError } from "@vykor/agent-contracts";


export type VykorAgentState =
  | "idle"
  | "running"
  | "maintaining"
  | "closing"
  | "closed";

const AGENT_OPERATION_CONFLICT = Symbol.for("@vykor/agent-runtime/AgentOperationConflictError");
export class AgentOperationConflictError extends Error {
  private readonly [AGENT_OPERATION_CONFLICT] = true;
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && AGENT_OPERATION_CONFLICT in value && value[AGENT_OPERATION_CONFLICT] === true;
  }

  constructor(
    readonly agentId: string,
    readonly state: VykorAgentState,
    readonly operation: string,
  ) {
    super(`Agent cannot ${operation} while ${state}: ${agentId}`);
    this.name = "AgentOperationConflictError";
  }
}

export function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error(typeof reason === "string" ? reason : "Run interrupted");
}

export function serializeError(error: unknown): AgentSerializedError {
  if (error instanceof Error) {
    const code =
      "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(code ? { code } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}
