import type { AgentRunScope } from "../execution/children.js";
import type { RunToolBinding } from "../execution/execution.js";
import type { ToolUseBlock } from "../conversation/messages.js";
import type { ToolExecutionResult, ToolOperationTicket, ToolDispatchReceipt } from "./tool-data.js";
export type { ToolOperationKind, ToolOperationState, ToolOperationTicket, ToolDispatchReceipt } from "./tool-data.js";
import type { RequiredPolicyGate } from "../policy/required-policy.js";

export interface ToolOperationIntent {
  scope: AgentRunScope;
  toolUse: ToolUseBlock;
  /** 宿主模型回合身份；同一 Run 的不同回合可以返回相同 provider 调用 ID。 */
  generationId?: string;
  binding?: RunToolBinding;
  parentOperationId?: string;
}
export interface ToolOperationGate {
  prepare(intent: ToolOperationIntent): Promise<ToolOperationTicket>;
  authorize(input: { intent: ToolOperationIntent; operation: ToolOperationTicket; policyVersion: string }): Promise<ToolOperationTicket>;
  dispatch(input: { intent: ToolOperationIntent; operation: ToolOperationTicket; policyVersion: string }): Promise<ToolDispatchReceipt>;
  settle(input: { receipt: ToolDispatchReceipt; result: ToolExecutionResult; late?: boolean }): Promise<void>;
  reject(input: { intent: ToolOperationIntent; operation: ToolOperationTicket; result: ToolExecutionResult }): Promise<void>;
}
export interface AgentToolSafety {
  operations: ToolOperationGate;
  requiredPolicy: RequiredPolicyGate;
  policyTimeoutMs?: number;
}
