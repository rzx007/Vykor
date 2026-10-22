import type {
  AgentRunScope,
  AgentChildController,
  ToolResult,
} from "@vykor/core";
import type { AgentDefinition } from "@vykor/coordinator/definitions";
export interface WorkflowInvocation {
  readonly input: Readonly<Record<string, unknown>>;
  readonly scope: AgentRunScope;
  readonly signal: AbortSignal;
  /** Trusted Run-bound child controller, supplied by execution rather than model input. */
  readonly children?: AgentChildController;
  /** Present even when empty: a captured Run catalog never falls back to host-wide roles. */
  readonly definitions?: readonly AgentDefinition[];
}
export interface WorkflowToolPort {
  invoke(call: WorkflowInvocation): Promise<ToolResult>;
}
