import { NodeRunCatalogue } from "../capabilities/node-run-catalogue.js";
import type {
  StreamingMessageClient,
  MutableToolRegistry as ToolRegistry,
  PermissionChecker,
  HookExecutor,
  RunToolBinding,
} from "@vykor/agent-contracts";
import type { Settings } from "@vykor/host-config";
import type {
  IQueryEngine as QueryEngine,
  QueryEngineOptions,
} from "@vykor/core/engine";
export interface NodeRunToolBinding extends RunToolBinding {
  readonly ownerPluginId?: string;
  readonly serverId?: string;
}

export interface RunSkillBinding {
  readonly ownerPluginId?: string;
  readonly path: string;
  readonly definition: {
    readonly name: string;
    readonly description: string;
    readonly content: string;
    readonly path: string;
    readonly source?: "bundled" | "user" | "project" | "plugin";
    readonly metadata?: Record<string, unknown>;
    readonly userInvocable: boolean;
    readonly disableModelInvocation: boolean;
    readonly model?: string;
    readonly argumentHint?: string;
    readonly commandName?: string;
    readonly displayName?: string;
  };
}

export interface RunAgentBinding {
  readonly ownerPluginId?: string;
  readonly definition: import("@vykor/coordinator/definitions").AgentDefinition;
}

export interface RunMcpServerBinding {
  readonly ownerPluginId?: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly definition: import("@vykor/host-config").McpServerConfig;
}

export interface RunCapabilityView {
  /** Explicit single-plugin restriction; automatic scopes use pluginIds even for one owner. */
  readonly pluginId?: string;
  /** Exact allowed plugin owners. Individual bindings remain the execution authority. */
  readonly pluginIds?: ReadonlySet<string>;
  readonly tools: ReadonlyMap<string, NodeRunToolBinding>;
  /** Host-only app directory under this Run's role/host/environment policy; never model execution. */
  readonly appTools?: ReadonlyMap<string, NodeRunToolBinding>;
  /** Host-captured bindings for child delegation; never executable by this Run. */
  readonly delegatableTools?: ReadonlyMap<string, NodeRunToolBinding>;
  readonly skills: ReadonlyMap<string, RunSkillBinding>;
  readonly mcpServers: ReadonlyMap<string, RunMcpServerBinding>;
  /** Configured and owner-authorized servers, including connections awaiting authentication. */
  readonly mcpAuthServers?: ReadonlyMap<string, RunMcpServerBinding>;
  readonly agents: ReadonlyMap<string, RunAgentBinding>;
}

export type RuntimeSandboxState = "off" | "active" | "degraded" | "unavailable";

export interface RuntimeSandboxStatus {
  state: RuntimeSandboxState;
  enabled: boolean;
  active: boolean;
  backend?: string;
  platform?: string;
  reason?: string;
  degraded?: boolean;
  networkMode?: string;
  dns?: string[];
  proxy?: "configured" | "not configured";
}

export class NodeRuntimeResources {
  childManager?: import("../../kernel/children/child-agent.js").AgentChildManager;
  toolFactoryOptions?: Parameters<
    typeof import("../tools/default-tool-registry.js").createDefaultToolRegistry
  >[0];
  mcpManager?: import("@vykor/mcp").McpClientManager;
  mcpAuth?: import("@vykor/tools").McpAuthHost;
  private cleanupCallbacks: Array<() => Promise<void> | void> = [];
  private syncCleanupCallbacks: Array<() => void> = [];
  sandboxStatus?: RuntimeSandboxStatus;
  /** Factory installed by the runtime host; never reloads components from disk. */
  createRunCapabilityView?: (
    pluginId?: string | readonly string[],
  ) => RunCapabilityView;
  resolveRequestConfiguration?: QueryEngineOptions["resolveRequestConfiguration"];
  /** Exact host-validated builtin replacements; source remains agent for identity checks. */
  trustedToolOverrides?: ReadonlyMap<
    string,
    Readonly<{
      identity: symbol;
      execute: import("@vykor/agent-contracts").ToolDefinition["execute"];
    }>
  >;

  constructor(
    public settings: Settings,
    public apiClient: StreamingMessageClient,
    public toolRegistry: ToolRegistry,
    public permissionChecker: PermissionChecker,
    public hookExecutor: import("@vykor/host-config").RegisteredHookExecutor,
    public queryEngine: QueryEngine,
    public runCatalogue: NodeRunCatalogue = new NodeRunCatalogue(),
  ) {}

  switchApiClient(newClient: StreamingMessageClient): void {
    this.apiClient = newClient;
    this.queryEngine.setApiClient(newClient);
  }

  addCleanup(
    cleanup: () => Promise<void> | void,
    cleanupSync?: () => void,
  ): void {
    this.cleanupCallbacks.push(cleanup);
    if (cleanupSync) this.syncCleanupCallbacks.push(cleanupSync);
  }

  async close(): Promise<void> {
    const callbacks = this.cleanupCallbacks.splice(0).reverse();
    this.syncCleanupCallbacks = [];
    const failures: unknown[] = [];
    for (const cleanup of callbacks) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Node runtime cleanup failed");
  }

  closeSync(): void {
    const callbacks = this.syncCleanupCallbacks.splice(0).reverse();
    this.cleanupCallbacks = [];
    const failures: unknown[] = [];
    for (const cleanup of callbacks)
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Node runtime synchronous cleanup failed",
      );
  }
}
