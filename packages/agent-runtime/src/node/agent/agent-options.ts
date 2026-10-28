import type {
  AgentEffects,
  AgentRunScope,
  StreamingMessageClient,
  ToolDefinition,
  AgentOutputContract,
  RunToolBinding,
  RunToolResultStore,
} from "@vykor/agent-contracts";
import type {
  AgentRequestConfigurationReader,
  AgentScheduleEffects,
} from "@vykor/host-config";
import type { RunCapabilityView } from "../runtime/node-runtime-resources.js";
import type { AgentChildBudget } from "@vykor/agent-contracts";
import type { ShellAdmissionPorts } from "@vykor/execution-node";
import type { PermissionMode, Settings } from "@vykor/host-config";
import type { ApprovalMode, WorkMode } from "@vykor/agent-contracts/permissions";
import type { TerminalProvider } from "@vykor/terminal";
import type { AgentJobHost } from "@vykor/jobs";
import type { WorkflowRunRepository } from "@vykor/coordinator";
import type { AgentChildEnvironmentProvider } from "../children/child-environment.js";
import type { ExecutionEnvironmentHandle } from "@vykor/environment";
import type { PluginSelectionCandidate } from "../plugins/plugin-selection.js";

/** Trusted prepared bindings for one actual Run; never serialized into model context or events. */
export interface AgentRunCapabilitySnapshot {
  readonly executionEnvironment?: { info: ExecutionEnvironmentHandle["info"]; workspace: ExecutionEnvironmentHandle["workspace"] };
  readonly resolveToolAppOrigin: (
    binding:
      import("../runtime/node-runtime-resources.js").NodeRunToolBinding | undefined,
  ) => Promise<import("@vykor/plugin-contracts/runtime").PluginAppToolOrigin | undefined>;
  readonly scope: AgentRunScope;
  readonly identity?: {
    readonly childId?: string;
    readonly parentSessionId?: string;
    readonly parentRunId?: string;
  };
  readonly capabilityView: RunCapabilityView;
  readonly pluginCandidates: readonly PluginSelectionCandidate[];
}

export type CapabilityOverride<T> = T | false;
/** Called once for each actual root or child session by the common Node composition. */
export type SessionCapabilityFactory<T> = (scope: Pick<AgentRunScope, "sessionId" | "cwd">) => T;

export interface AgentCapabilityOverrides {
  terminal?: CapabilityOverride<SessionCapabilityFactory<TerminalProvider>>;
  backgroundShell?: CapabilityOverride<SessionCapabilityFactory<ShellAdmissionPorts>>;
  jobs?: false;
  memory?: false;
  childEnvironment?: CapabilityOverride<AgentChildEnvironmentProvider>;
  workflowRepository?: CapabilityOverride<WorkflowRunRepository>;
  schedules?: CapabilityOverride<AgentScheduleEffects>;
}

export interface AgentEffectOverrides {
  requestPermission?: AgentEffects["requestPermission"];
  askUserPrompt?: AgentEffects["askUserPrompt"];
}

/** Opinionated runtime configuration exposed by the programmatic agent API. */
export interface VykorAgentConfiguration {
  jobArchiveForSession?: (sessionId: string) => { agent?: Pick<AgentJobHost, "list" | "read">; process?: Pick<AgentJobHost, "list" | "read"> };
  /** Trusted host-owned result validation; ordinary chat output remains unrestricted when omitted. */
  outputContract?: AgentOutputContract;
  /** Bind the host's authorized archive to the final captured tools for each Run. */
  toolResults?: (scope: AgentRunScope, tools: ReadonlyMap<string, RunToolBinding>) => RunToolResultStore | Promise<RunToolResultStore>;
  /** Bind the current host dispatch check to each Run and its final tools; descendants bind their own scope. */
  bindToolDispatch?: import("@vykor/agent-contracts").ToolDispatchCheckFactory;
  /** Host-owned admission and durable settlement for this agent tree's actual model attempts. */
  modelAttempts?: import("@vykor/agent-contracts").ModelAttemptGate;
  /** Reliable host-only registration after durable Run start, before model dispatch. Return a terminal cleanup. */
  onRunCapabilities?: (
    snapshot: AgentRunCapabilitySnapshot,
  ) =>
    | void
    | (() => void | Promise<void>)
    | Promise<void | (() => void | Promise<void>)>;
  /** Host-owned project identity for memory, independent from a task worktree cwd. */
  memoryRoot?: string;
  client?: StreamingMessageClient;
  apiKey?: string;
  apiFormat?: Settings["apiFormat"];
  baseUrl?: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  approvalMode?: ApprovalMode;
  workMode?: WorkMode;
  maxTurns?: number;
  /** Maximum tools granted by the SDK/host. Descendant agents inherit this ceiling. */
  hostToolCeiling?: string[];
  /** Tools this agent role wants to see. ["*"] means no extra role narrowing. */
  roleAllowedTools?: string[];
  disallowedTools?: string[];
  effort?: Settings["effort"];
  reasoningEffort?: string;
  fastMode?: boolean;
  /** Per-agent override for the installed Native Plugin master switch. */
  pluginsEnabled?: boolean;
  autoApproveReadOnly?: boolean;
  autoApproveTools?: string[];
  /** Trusted host wrappers receive the already-bound default tool on each Run. */
  toolDecorators?: readonly {
    name: string;
    decorate(base: ToolDefinition): ToolDefinition;
  }[];
  /** New tools. Creation fails if any name already exists. */
  tools?: ToolDefinition[];
  /** Complete replacements for existing built-in tools. */
  toolOverrides?: ToolDefinition[];
  /** First-party replacements that retain the replaced built-in permission classification. */
  trustedToolOverrides?: string[];
  /**
   * Trusted host-only text execution: no model-visible tools, plugins, MCP
   * connections, programmatic extensions or hooks. This is an execution
   * constraint, not a rule about which result the parent may receive.
   */
  internalTextOnly?: boolean;
  /** Overrides the root-tree child-agent limits. */
  childBudget?: Partial<AgentChildBudget>;
  /** Selects the managed Desktop environment path; CLI callers omit it. */
  executionSurface?: "desktop_managed" | "cli_advanced";
  /** Called once per actual root or child session with its effective execution policy. */
  executionEnvironment?: (scope: Pick<AgentRunScope, "sessionId" | "cwd"> & {
    settings: Settings;
  }) => Promise<ExecutionEnvironmentHandle>;
  /** Transfer each returned environment lease to its Node agent; omitted means borrowed. */
  ownsExecutionEnvironment?: boolean;
  /** Host-owned persistent selection store; default agents use an in-memory store. */
  requestConfigurationStore?: AgentRequestConfigurationReader;
  /** The host provides a separate durable reader for each new child session. */
  requestConfigurationStoreForSession?: (
    sessionId: string,
  ) => AgentRequestConfigurationReader | undefined;
  /** Existing host catalog/authorization validation, before any child environment side effects. */
  validateModelSelection?: (input: { provider?: string; model: string; effort?: string; explicitEffort: boolean }) => Promise<{ effort?: string }>;
  /** Host-owned model capacity lookup; absent for SDK callers without a catalog. */
  resolveModelContextWindow?: (input: {
    provider?: string;
    model: string;
  }) => Promise<number | undefined>;
  /** Host-owned output capacity lookup; absent for SDK callers without a catalog. */
  resolveModelOutputLimit?: (input: {
    provider?: string;
    model: string;
  }) => Promise<number | undefined>;
  /** Host-owned effort catalog; absent for callers with their own client. */
  resolveReasoningEfforts?: (input: {
    provider?: string;
    model: string;
  }) => Promise<string[] | undefined>;
}
