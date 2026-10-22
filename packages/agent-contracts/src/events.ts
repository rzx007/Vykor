import type { ContentBlock, ToolUseBlock } from "./messages.js";
import type { AssistantMessagePhase } from "./messages.js";
import type { UsageSnapshot } from "./usage.js";
import type {
  GenerationIdentity,
  ModelAttemptFinishedEvent,
  ModelRetryState,
} from "./model.js";

export interface TextDeltaEvent {
  type: "text_delta";
  delta: string;
  phase?: AssistantMessagePhase;
}

export type ReasoningSource = "reasoning_content" | "think";

export interface ReasoningDeltaEvent {
  type: "reasoning_delta";
  delta: string;
  source: ReasoningSource;
}

export interface ToolUseStartEvent {
  type: "tool_use_start";
  toolUse: ToolUseBlock;
}

/** Display-only: partial arguments never authorize or execute a tool. */
export interface ToolGenerationProgressEvent {
  type: "tool_generation_progress";
  toolKey: string;
  toolUseId?: string;
  toolName?: string;
  receivedChars: number;
  /** Omitted keeps the current display path; null explicitly withdraws it. */
  filePath?: string | null;
  discarded?: boolean;
  generationId?: string;
  attempt?: number;
}

export interface ToolUseEndEvent {
  type: "tool_use_end";
  toolUseId: string;
  result: {
    content: ContentBlock[];
    isError?: boolean;
    failureKind?: import("./index.js").ToolFailureKind;
    executionState?: import("./index.js").ToolExecutionState;
    recoveryHint?: string;
    compactSummary?: string;
    toolAttemptId?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface ErrorEvent {
  type: "error";
  error: Error;
}

export interface UsageEvent {
  type: "usage";
  usage: UsageSnapshot;
}

export interface CompleteEvent {
  type: "complete";
  stopReason: string;
}

/**
 * 每次实际请求前发出。重试开始时，它同时是「撤换上一次残缺输出」的明确边界：
 * 文本等事件在有序流内归属最近的 generation_started。
 */
export type GenerationStartedEvent = GenerationIdentity & {
  type: "generation_started";
};

/** 等待下一次重试前发出，携带次数、原因和截止时间。 */
export type ModelRetryEvent = ModelRetryState & { type: "model_retry" };

export type StreamEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolUseStartEvent
  | ToolGenerationProgressEvent
  | ToolUseEndEvent
  | ErrorEvent
  | UsageEvent
  | CompleteEvent
  | GenerationStartedEvent
  | ModelRetryEvent
  | ModelAttemptFinishedEvent;

import type { ModelAttemptStarted, ModelAttemptUsageStatus } from "./model.js";
import type { AgentPermissionRequest, AgentPermissionDecision } from "./permissions.js";
import type { AgentModelConfiguration } from "./execution.js";
import type {
  AgentChildSpawnInput,
} from "./children.js";
import type {
  AgentChildResult,
  ChildFailureKind,
  ChildPartialResult,
} from "./children.js";

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
        phase?: import("./index.js").AssistantMessagePhase;
      };
    }
  | {
      type: "output.reasoning.delta";
      data: {
        delta: string;
        source: ReasoningSource;
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
          failureKind?: import("./index.js").ToolFailureKind;
          executionState?: import("./index.js").ToolExecutionState;
          recoveryHint?: string;
          compactSummary?: string;
          metadata?: Record<string, unknown>;
          toolAttemptId?: string;
        };
      };
    }
  | { type: "usage.updated"; data: { usage: import("./index.js").UsageSnapshot } }
  | { type: "output.generation.started"; data: GenerationIdentity }
  | { type: "model.retry.scheduled"; data: ModelRetryState }
  | { type: "model.attempt.started"; data: ModelAttemptStarted }
  | {
      type: "model.attempt.finished";
      data: GenerationIdentity & {
        status: "completed" | "failed" | "interrupted";
        usageStatus: ModelAttemptUsageStatus;
        usage?: import("./index.js").UsageSnapshot;
        notDispatched?: true;
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
        parentRequestConfiguration?: AgentModelConfiguration;
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
