import type { ContentBlock } from "./messages.js";
import type { GenerationIdentity, ModelAttemptUsageStatus, ModelRetryState } from "../engine/model-retry.js";
import type { AgentPermissionRequest, AgentPermissionDecision, AgentRequestConfiguration } from "./runtime.js";
import type { AgentChildSpawnInput, AgentChildResult, ChildFailureKind, ChildPartialResult } from "./runtime-child.js";

export interface AgentEventContext {
  agentId: string;
  sessionId: string;
  inputId?: string;
  runId?: string;
  traceId?: string;
  childId?: string;
  parentSessionId?: string;
  parentRunId?: string;
}

export interface AgentSerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

export type AgentEventInput =
  | {
      type: "input.accepted";
      data: {
        content: string | ContentBlock[];
        inputItems?: readonly unknown[];
        delivery: "queue" | "steer";
        metadata?: Record<string, unknown>;
      };
    }
  | { type: "run.started"; data: Record<string, never> }
  | { type: "run.completed"; data: { output: string; stopReason?: string } }
  | {
      type: "run.failed";
      data: {
        error: AgentSerializedError;
        output?: string;
        failureKind?: ChildFailureKind;
        partialResult?: ChildPartialResult;
      };
    }
  | {
      type: "run.interrupted";
      data: {
        error: AgentSerializedError;
        output?: string;
        failureKind?: ChildFailureKind;
        partialResult?: ChildPartialResult;
      };
    }
  | {
      type: "output.text.delta";
      data: {
        delta: string;
        phase?: import("./messages").AssistantMessagePhase;
      };
    }
  | {
      type: "output.reasoning.delta";
      data: {
        delta: string;
        source: import("./events").ReasoningSource;
      };
    }
  | { type: "output.turn.completed"; data: { stopReason: string } }
  | {
      type: "tool.started";
      data: {
        toolUse: {
          type: "tool_use";
          id: string;
          name: string;
          input: Record<string, unknown>;
        };
      };
    }
  | {
      type: "tool.completed";
      data: {
        toolUseId: string;
        result: {
          content: ContentBlock[];
          isError?: boolean;
          failureKind?: import("./tools").ToolFailureKind;
          executionState?: import("./tools").ToolExecutionState;
          recoveryHint?: string;
          compactSummary?: string;
          metadata?: Record<string, unknown>;
          toolAttemptId?: string;
        };
      };
    }
  | { type: "usage.updated"; data: { usage: import("./usage").UsageSnapshot } }
  | { type: "output.generation.started"; data: GenerationIdentity }
  | { type: "model.retry.scheduled"; data: ModelRetryState }
  | {
      type: "model.attempt.finished";
      data: GenerationIdentity & {
        status: "completed" | "failed" | "interrupted";
        usageStatus: ModelAttemptUsageStatus;
        usage?: import("./usage").UsageSnapshot;
      };
    }
  | {
      type: "domain.event";
      data: { name: string; payload?: Record<string, unknown> };
    }
  | {
      type: "permission.requested";
      data: { requestId: string; request: AgentPermissionRequest };
    }
  | {
      type: "permission.resolved";
      data: { requestId: string; decision: AgentPermissionDecision };
    }
  | {
      type: "child.created";
      data: {
        childId: string;
        sessionId: string;
        spawn: AgentChildSpawnInput;
        parentRequestConfiguration?: AgentRequestConfiguration;
        cwd: string;
        worktree?: { path: string; branch: string };
      };
    }
  | { type: "child.suspended"; data: { childId: string; sessionId: string } }
  | { type: "child.resumed"; data: { childId: string; sessionId: string } }
  | {
      type: "child.closed";
      data: { childId: string; sessionId: string; result: AgentChildResult };
    };

export type AgentEvent = AgentEventInput & {
  id: string;
  sequence: number;
  occurredAt: string;
  context: AgentEventContext;
};

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

export type AgentEventSubscription = () => void;

export interface AgentEventSource {
  subscribe(listener: AgentEventListener): AgentEventSubscription;
}
