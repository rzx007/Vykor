import type { StreamingMessageClient, AgentExecutionContext, ToolUseBlock, ContentBlock, Message, StreamEvent, RunToolBinding } from "@vykor/agent-contracts";
import type { CompactContextProvider } from "../engine/compact-service";
import type { ModelRetryPolicy } from "../engine/model-retry";

/** A fully prepared model request captured at one request boundary. */
export type QueryRequestConfiguration = {
  revision: number;
  model: string;
  provider?: string;
  baseUrl?: string;
  apiFormat?: "anthropic" | "openai";
  effort?: string;
  maxTurns?: number;
  reasoningEffort?: string;
  client: StreamingMessageClient;
  systemPrompt?: string;
  /** Internal request snapshot builder; receives the exact tools sent to the model. */
  systemPromptForTools?: (tools: readonly import("@vykor/agent-contracts").ToolDefinition[]) => Promise<string>;
  contextWindow?: number;
  maxOutputTokens?: number;
};

export interface QueryEngine {
  executeTool(
    toolUse: ToolUseBlock,
    options: { signal?: AbortSignal; execution: AgentExecutionContext;
      /** Reliable delivery of a collected result before a later execution-chain failure propagates. */
      onResult?: (result: import("@vykor/agent-contracts").ToolExecutionResult) => Promise<void>;
    },
  ): Promise<import("@vykor/agent-contracts").ToolExecutionResult>;
  submitMessage(
    content: string | ContentBlock[],
    options?: {
      signal?: AbortSignal;
      execution?: AgentExecutionContext;
    },
  ): AsyncIterable<StreamEvent>;
  getHistory(): Message[];
  getAppliedRequestConfiguration?(): QueryRequestConfiguration | undefined;
  getContextUsagePromptSource(): {
    systemPrompt?: string;
    memoryReminderText?: string;
  };
  compact(): Promise<void>;
  clear(): void;
  setSystemPrompt(prompt: string): void;
  setApiClient(client: StreamingMessageClient): void;
  setModel(model: string): void;
  setMaxTurns(max: number): void;
  loadMessages(messages: Message[]): void;
  getTotalUsage(): import("@vykor/agent-contracts").UsageSnapshot;
  setMemoryRetriever(retriever: MemoryRetriever | undefined): void;
  setCompactContextProvider(fn: CompactContextProvider | undefined): void;
  setAllowedTools(tools: string[] | null): void;
  setSessionId(sessionId: string | undefined): void;
}

export interface MemoryRetriever {
  (userInput: string): Promise<string | null> | string | null;
}

export interface QueryEngineOptions {
  /** Optional host policy. Omission preserves full authorized tool exposure. */
  toolDiscovery?: {
    searchTool: import("@vykor/agent-contracts").ToolDefinition;
    shouldDefer: (tool: import("@vykor/agent-contracts").ToolDefinition, source?: import("@vykor/agent-contracts").ToolRegistrationSource) => boolean;
    /** Deferral starts when either threshold is reached. Default: 20 tools. */
    minToolCount?: number;
    /** Serialized deferred definitions (name, description, schema). Default: 32 KiB. */
    minSchemaBytes?: number;
  };
  /** Current runtime permission owner; omitted when mode tools are unsupported. */
  setPlanMode?: import("@vykor/agent-contracts").ToolContext["setPlanMode"];
  /** Exact tool definitions validated by the host as trusted builtin replacements. */
  trustedToolOverrides?: ReadonlyMap<string, import("@vykor/agent-contracts").ToolDefinition>;
  /** Host-provided Run prompt. With a View, takes precedence over systemPrompt/setSystemPrompt(). */
  systemPromptForRun?: (tools: ReadonlyMap<string, RunToolBinding>) => Promise<string>;
  /** Builds capability guidance after finalization and trajectory tool filtering. */
  systemPromptForTools?: (tools: readonly import("@vykor/agent-contracts").ToolDefinition[], bindings?: ReadonlyMap<string, RunToolBinding>) => Promise<string>;
  maxTurns?: number;
  /** Runtime working directory used for all tool execution in this engine. */
  cwd?: string;
  /** Runtime session id used to scope task/swarm ownership. */
  sessionId?: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  reasoningEffort?: string;
  /** Resolves a stable model/client pair before each model request. */
  resolveRequestConfiguration?: (input: {
    signal?: AbortSignal;
    tools?: ReadonlyMap<string, RunToolBinding>;
  }) => Promise<QueryRequestConfiguration>;
  /** Resolved host timeout in milliseconds; the execution default is 300000. */
  toolTimeoutMs?: number;
  toolOutputPolicy?: { inlineChars: number; previewChars: number };
  compactKeepRecent?: number;
  memoryRetriever?: MemoryRetriever;
  executionEnvironment?: import("@vykor/environment").ExecutionEnvironmentHandle;
  /** Optional per-run trajectory policy factory. False disables the default tracker. */
  trajectoryTrackerFactory?: false | (() => import("../engine/trajectory/tracker").TrajectoryTracker);
  compactProgressCallback?: import("../engine/compact-service").CompactProgressCallback;
  /** 有界模型网络重试策略；`maxTotalRetries: 0` 可显式关闭自动重试。 */
  modelRetry?: Partial<ModelRetryPolicy>;
}
