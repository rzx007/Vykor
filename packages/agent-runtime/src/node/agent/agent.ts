import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentEffects,
  AgentRunHandle,
  AgentRunScope,
  AgentRunResult,
  AgentRunContribution,
  AgentEventListener,
  ContentBlock,
  ToolDescriptor,
  ToolRegistrationSource,
  ToolExecutionResult,
  ToolUseBlock,
  RunToolBinding,
  AgentEventInput,
} from "@vykor/agent-contracts";
import type { AgentSession } from "@vykor/core";
import type {
  AgentRequestConfigurationReader,
  AgentRequestConfigurationPatch,
  AgentRequestConfigurationSnapshot,
  AgentRequestConfigurationStore,
  Settings,
  HookDefinition,
} from "@vykor/host-config";
import type { McpConnection, McpRuntimeRegistry } from "@vykor/mcp";
import type { PluginAppHostInvocation, PluginAppToolOrigin } from "@vykor/plugin-contracts/runtime";
import { copyPluginAppJson, PluginAppValidationError } from "@vykor/plugin-contracts/runtime-data";
import { PLUGIN_APP_DATA_LIMITS } from "@vykor/plugin-contracts/limits";
import {
  KernelAgent,
  type VykorAgent,
  type VykorAgentSubmitOptions as KernelSubmitOptions,
  type VykorAgentRunToolOptions,
  type ModelVisibleTool,
} from "../../kernel/agent.js";
export type {
  VykorAgent,
  VykorAgentRunToolOptions,
  ModelVisibleTool,
  AgentCompactResult,
  ContextUsagePromptSource,
} from "../../kernel/agent.js";
export {
  AgentOperationConflictError,
  type VykorAgentState,
} from "../../kernel/agent-errors.js";
import { AgentOperationConflictError } from "../../kernel/agent-errors.js";
import {
  AgentChildRegistry,
  type AgentChildManager,
} from "../../kernel/children/child-agent.js";
import { AgentEventBus } from "../../kernel/event-source.js";
import type { FrameworkAgentRunToolActivity } from "../../kernel/framework-agent-run.js";
import type { AgentIdentity } from "./agent-composition.js";
import type {
  AgentCapabilityOverrides,
  AgentEffectOverrides,
  VykorAgentConfiguration,
} from "./agent-options.js";
import {
  toAgentCapabilitySnapshot,
  type AgentCapabilitySnapshot,
  type ResolvedAgentCapabilities,
} from "../capabilities/capability-resolution.js";
import type {
  AgentMemoryRuntime,
  AgentRememberOptions,
  AgentRememberResult,
} from "../memory/memory-runtime.js";
import { createMemoryRequestConfigurationStore } from "../configuration/request-configuration.js";
import { createRunCapabilityView } from "../plugins/run-capability-view.js";
import { readonlyMap } from "@vykor/agent-contracts";
import { constrainRunCapabilityTools } from "../tools/default-runtime-tools.js";
import { renderPluginDiscoveryContext } from "../plugins/plugin-discovery-context.js";
import type {
  PluginSelectionCandidate,
  PluginSelectionCatalog,
} from "../plugins/plugin-selection.js";
import {
  PluginAppRuntime,
  type PluginAppRuntimeHost,
} from "../plugin-apps/plugin-app-runtime.js";
import type { PluginAppBackendCatalogue } from "../plugin-apps/plugin-app-backends.js";
import type {
  NodeRuntimeResources as RuntimeBundle,
  RunCapabilityView,
  NodeRunToolBinding,
} from "../runtime/node-runtime-resources.js";
import type { VykorAgentExtension } from "../plugins/extensions.js";
import type { WorkflowHost } from "../workflow/workflow-host.js";
import { prepareNodeRunTools } from "../tools/prepare-run-tools.js";
export interface VykorAgentOptions extends VykorAgentConfiguration {
  settings?: Settings;
  cwd?: string;
  sessionId?: string;
  mcpServers?: Settings["mcpServers"];
  extensions?: VykorAgentExtension[];
  childIdleTtlMs?: number;
  /** Host-owned registry that coordinates OAuth-driven MCP Runtime reconnects. */
  mcpRuntimeRegistry?: McpRuntimeRegistry;
  /** Reliable ordered host sink. A rejection fails the active framework operation. */
  onEvent?: AgentEventListener;
  /** 逐项替换或关闭默认能力；未传的项目继续使用各自默认值。 */
  capabilityOverrides?: AgentCapabilityOverrides;
  /** 宿主交互副作用；未提供审批器时 ask 会安全拒绝。 */
  effects?: AgentEffectOverrides;
}
export interface VykorAgentSubmitOptions extends KernelSubmitOptions {
  capabilityView?: RunCapabilityView;
  pluginCandidates?: readonly PluginSelectionCandidate[];
  pluginGuidance?: string;
}
export interface NodeAgentHost {
  plugins: {
    pluginApps: PluginAppRuntimeHost;
    prepareRun(
      view: RunCapabilityView,
    ): import("@vykor/agent-contracts").AgentRunPreparation;
    createRunCapabilityView(
      pluginId?: string | readonly string[],
    ): RunCapabilityView;
    getPluginCandidates(): readonly PluginSelectionCandidate[];
    validatePluginScope(
      candidates: readonly PluginSelectionCandidate[],
      signal: AbortSignal,
    ): Promise<void>;
    runPluginAppTool(
      invocation: PluginAppHostInvocation,
      options: Omit<VykorAgentRunToolOptions, "tools">,
    ): Promise<ToolExecutionResult>;
    toolOrigin(
      binding: NodeRunToolBinding | undefined,
    ): Promise<PluginAppToolOrigin | undefined>;
    getCapabilities(): AgentCapabilitySnapshot;
    listModelVisibleTools(): ModelVisibleTool[];
  };
  configuration: {
    getSnapshot(): Promise<AgentRequestConfigurationSnapshot>;
    updateConfiguration(
      patch: AgentRequestConfigurationPatch,
    ): Promise<AgentRequestConfigurationSnapshot>;
    setModel(model: string): void;
  };
  memory: {
    remember(options?: AgentRememberOptions): Promise<AgentRememberResult>;
  };
  inspect(): AgentInspection;
  readonly workflows: WorkflowHost | undefined;
}
export interface DefaultNodeAgent extends VykorAgent {
  readonly host: NodeAgentHost;
  submitMessage(
    content: string | ContentBlock[],
    options?: VykorAgentSubmitOptions,
  ): AgentRunHandle;
  runMessage(
    content: string | ContentBlock[],
    options?: VykorAgentSubmitOptions,
  ): Promise<AgentRunResult>;
}
export interface HostedAgent {
  agent: VykorAgent;
  host: NodeAgentHost | undefined;
}
export interface AgentInspection {
  model: string;
  tools: Array<{
    name: string;
    source: ToolRegistrationSource;
    overrides?: ToolRegistrationSource;
  }>;
  hooks: Array<Pick<HookDefinition, "id" | "event" | "type" | "enabled">>;
  mcpServers: Array<{
    name: string;
    status: string;
    toolCount: number;
    resourceCount: number;
    command?: string;
    error?: string;
  }>;
  sandbox?: NonNullable<RuntimeBundle["sandboxStatus"]>;
  childBudget: import("@vykor/agent-contracts").AgentChildBudgetSnapshot;
  capabilities: AgentCapabilitySnapshot;
}
export interface AssembledAgentOptions {
  runtime: RuntimeBundle;
  pluginApps?: PluginAppBackendCatalogue;
  pluginSelection?: PluginSelectionCatalog;
  onRunCapabilities?: VykorAgentConfiguration["onRunCapabilities"];
  modelAttempts?: VykorAgentConfiguration["modelAttempts"];
  toolSafety?: VykorAgentConfiguration["toolSafety"];
  session: AgentSession;
  mcpConnections: () => readonly McpConnection[];
  retainMcpConnectionsForRun?: () => () => void;
  memory: AgentMemoryRuntime | undefined;
  eventBus: AgentEventBus;
  effects: AgentEffects;
  identity: AgentIdentity | undefined;
  childManager: AgentChildManager;
  cleanup?: {
    close(): Promise<void>;
  };
  stopBackgroundWork?: () => Promise<void>;
  childDirectory: AgentChildRegistry;
  capabilities: ResolvedAgentCapabilities;
  model: string;
  workflowHost?: WorkflowHost;
  requestConfigurationStore?: AgentRequestConfigurationReader;
}
class NodeAgent extends KernelAgent implements DefaultNodeAgent {
  readonly host: NodeAgentHost;
  private readonly appRuntime: PluginAppRuntime;
  private readonly runtime: RuntimeBundle;
  private readonly requestConfigurationStore: AgentRequestConfigurationReader;
  private model: string;
  private readonly preparedRegistrations = new Map<
    string,
    () => Promise<void>
  >();
  private registrationUnsubscribe?: () => void;
  private completedRunToolActivity?: FrameworkAgentRunToolActivity;
  constructor(private readonly assembled: AssembledAgentOptions) {
    let self: NodeAgent;
    super({
      id: assembled.session.id,
      cwd: assembled.childManager.cwd,
      engine: assembled.runtime.queryEngine,
      effects: assembled.effects,
      toolSafety: assembled.toolSafety,
      eventBus: assembled.eventBus,
      childManager: assembled.childManager,
      childDirectory: assembled.childDirectory,
      identity: assembled.identity,
      preparation: { prepare: (scope) => self.prepare(scope, {}) },
      onSettled: (_result, activity) => {
        if (activity) self.completedRunToolActivity = activity;
      },
      prepareClose: assembled.stopBackgroundWork,
      release: async () => {
        self.registrationUnsubscribe?.();
        self.appRuntime.host.clear();
        const failures: unknown[] = [];
        for (const cleanup of [
          () => assembled.cleanup?.close(),
          () => assembled.runtime.close(),
        ])
          try {
            await cleanup();
          } catch (e) {
            failures.push(e);
          }
        if (failures.length)
          throw new AggregateError(failures, "Node cleanup failed");
      },
    });
    self = this;
    this.registrationUnsubscribe = assembled.eventBus.addSink(async (event) => {
      if (event.type === "run.started" && event.context.agentId === this.id)
        await this.preparedRegistrations.get(event.context.runId!)?.();
    });
    this.runtime = assembled.runtime;
    this.runtime.childManager = assembled.childManager;
    this.model = assembled.model;
    this.requestConfigurationStore =
      assembled.requestConfigurationStore ??
      createMemoryRequestConfigurationStore(
        { model: this.model },
        async (next) => next,
      );
    this.appRuntime = new PluginAppRuntime(this.id, assembled.pluginApps);
    this.host = Object.freeze({
      plugins: Object.freeze({
        pluginApps: this.appRuntime.host,
        prepareRun: (view: RunCapabilityView) => ({
          prepare: (scope: AgentRunScope) =>
            this.prepare(scope, { capabilityView: view, explicitView: true }),
        }),
        createRunCapabilityView: this.createRunCapabilityView.bind(this),
        getPluginCandidates: this.getPluginCandidates.bind(this),
        validatePluginScope: this.validatePluginScope.bind(this),
        runPluginAppTool: this.runPluginAppTool.bind(this),
        toolOrigin: this.appRuntime.toolOrigin.bind(this.appRuntime),
        getCapabilities: this.getCapabilities.bind(this),
        listModelVisibleTools: this.listModelVisibleTools.bind(this),
      }),
      configuration: Object.freeze({
        getSnapshot: () => this.requestConfigurationStore.read(),
        updateConfiguration: this.updateConfiguration.bind(this),
        setModel: this.setModel.bind(this),
      }),
      memory: Object.freeze({ remember: this.remember.bind(this) }),
      inspect: this.inspect.bind(this),
      workflows: assembled.workflowHost,
    });
  }
  override submitMessage(
    content: string | ContentBlock[],
    options: VykorAgentSubmitOptions = {},
  ): AgentRunHandle {
    this.completedRunToolActivity = { toolUses: [], toolResults: [] };
    const candidates = Object.freeze(
      (options.pluginCandidates ?? this.getPluginCandidates()).map(
        (candidate) => Object.freeze({ ...candidate }),
      ),
    );
    const view =
      options.capabilityView ??
      this.createRunCapabilityView(
        candidates.length ? candidates.map((item) => item.pluginId) : undefined,
      );
    return super.submitMessage(content, {
      ...options,
      preparation: options.preparation ?? {
        prepare: (scope) =>
          this.prepare(scope, {
            ...options,
            capabilityView: view,
            pluginCandidates: candidates,
            explicitView: !!options.capabilityView,
          }),
      },
    });
  }
  override loadHistory(
    messages: import("@vykor/agent-contracts").Message[],
  ): void {
    super.loadHistory(messages);
    this.completedRunToolActivity = undefined;
  }
  override clear(): void {
    super.clear();
    this.completedRunToolActivity = undefined;
  }
  private async prepare(
    scope: AgentRunScope,
    options: VykorAgentSubmitOptions & {
      explicitView?: boolean;
    },
  ) {
    const releaseConnections =
      this.assembled.retainMcpConnectionsForRun?.() ?? (() => {});
    let releaseHost: (() => void | Promise<void>) | undefined;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      this.preparedRegistrations.delete(scope.runId);
      try {
        await releaseHost?.();
      } finally {
        releaseConnections();
      }
    };
    try {
      const candidates = this.getPluginCandidates();
      let view =
        options.capabilityView ??
        this.createRunCapabilityView(candidates.map((c) => c.pluginId));
      const owners =
        view.pluginIds ?? new Set(view.pluginId ? [view.pluginId] : []);
      const scoped = (options.pluginCandidates ?? candidates).filter((c) =>
        owners.has(c.pluginId),
      );
      if (options.explicitView) {
        view = constrainRunCapabilityTools(this.runtime.toolRegistry, view);
        if (this.assembled.pluginSelection) {
          for (const id of owners)
            if (!scoped.some((c) => c.pluginId === id))
              throw new Error(`Plugin owner is not available: ${id}`);
          await this.validatePluginScope(scoped, scope.signal);
        }
      } else {
        const available: string[] = [];
        for (const candidate of scoped)
          try {
            await this.validatePluginScope([candidate], scope.signal);
            available.push(candidate.pluginId);
          } catch {
            scope.signal.throwIfAborted();
          }
        view = this.createRunCapabilityView(available);
      }
      scope.signal.throwIfAborted();
      const ids =
        view.pluginIds ?? new Set(view.pluginId ? [view.pluginId] : []);
      const accepted = scoped.filter((c) => ids.has(c.pluginId));
      view = Object.freeze({
        ...view,
        tools: prepareNodeRunTools(this.runtime, view, accepted),
      });
      const guidance = [
        renderPluginDiscoveryContext({
          candidates,
          allowedPluginIds: ids,
          capabilityView: view,
        }),
        options.pluginGuidance,
      ]
        .filter(Boolean)
        .join("\n\n");
      this.preparedRegistrations.set(scope.runId, async () => {
        const registration = await this.assembled.onRunCapabilities?.(
          Object.freeze({
            scope: Object.freeze({ ...scope }),
            executionEnvironment: this.runtime.toolFactoryOptions?.environment ? { info: this.runtime.toolFactoryOptions.environment.info, workspace: this.runtime.toolFactoryOptions.environment.workspace } : undefined,
            identity: this.assembled.identity,
            capabilityView: view,
            pluginCandidates: Object.freeze(accepted),
            resolveToolAppOrigin: this.appRuntime.toolOrigin.bind(
              this.appRuntime,
            ),
          }),
        );
        if (typeof registration === "function") releaseHost = registration;
        await this.validatePluginScope(accepted, scope.signal);
        scope.signal.throwIfAborted();
      });
      scope.signal.throwIfAborted();
      return {
        run: {
          tools: view.tools,
          modelAttempts: this.assembled.modelAttempts,
          toolSafety: this.assembled.toolSafety,
          profile: { toolResultReferences: ids.size > 0 },
          ...(guidance ? { contribution: { systemGuidance: guidance } } : {}),
        },
        release,
      };
    } catch (error) {
      try {
        await release();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Run preparation cleanup failed",
        );
      }
      throw error;
    }
  }
  createRunCapabilityView(
    pluginId?: string | readonly string[],
  ): RunCapabilityView {
    return (
      this.runtime.createRunCapabilityView?.(pluginId) ??
      createRunCapabilityView(
        { toolRegistry: this.runtime.toolRegistry },
        pluginId,
      )
    );
  }
  getPluginCandidates(): readonly PluginSelectionCandidate[] {
    return Object.freeze(
      (this.assembled.pluginSelection?.candidates ?? []).map((candidate) =>
        Object.freeze({ ...candidate }),
      ),
    );
  }
  async validatePluginScope(
    candidates: readonly PluginSelectionCandidate[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    for (const candidate of candidates) {
      const current = this.assembled.pluginSelection?.candidates.find(
        (item) => item.pluginId === candidate.pluginId,
      );
      if (
        !current ||
        current.version !== candidate.version ||
        current.behaviorDigest !== candidate.behaviorDigest
      ) {
        throw new Error(
          `Plugin changed since scope capture: ${candidate.pluginId}`,
        );
      }
      await this.assembled.pluginSelection!.validate(current);
      signal.throwIfAborted();
    }
  }
  setModel(model: string): void {
    if (this.state !== "idle")
      throw new AgentOperationConflictError(
        this.id,
        this.state,
        "set the model",
      );
    const store = this
      .requestConfigurationStore as AgentRequestConfigurationReader & {
      replaceSynchronously?: (
        patch: AgentRequestConfigurationPatch,
      ) => AgentRequestConfigurationSnapshot;
    };
    if (!store.replaceSynchronously) {
      throw new Error("Host-owned configuration requires a session update");
    }
    store.replaceSynchronously({ model });
    this.model = model;
    this.runtime.queryEngine.setModel(model);
  }
  async updateConfiguration(
    patch: AgentRequestConfigurationPatch,
  ): Promise<AgentRequestConfigurationSnapshot> {
    if (this.state === "closing" || this.state === "closed") {
      throw new AgentOperationConflictError(
        this.id,
        this.state,
        "update configuration",
      );
    }
    if (!("update" in this.requestConfigurationStore)) {
      throw new Error("Host-owned configuration requires a session update");
    }
    const snapshot = await (
      this.requestConfigurationStore as AgentRequestConfigurationStore
    ).update(patch);
    this.model = snapshot.configuration.model;
    return snapshot;
  }
  remember(options?: AgentRememberOptions): Promise<AgentRememberResult> {
    const controller = new AbortController();
    return this.runMaintenance("remember", async () => {
      const origin = options?.execution?.scope;
      if (origin && origin.sessionId !== this.id) throw new Error("Memory execution session does not match this agent");
      if (!this.assembled.memory) {
        return {
          skipped: true,
          reason: "memory is disabled",
          writtenIds: [],
          titles: [],
        };
      }
      return await this.assembled.memory.remember(
        this.getHistory(),
        this.runtime.apiClient,
        this.model,
        this.completedRunToolActivity,
        options?.automatic,
        options?.execution
          ? {
              ...options.execution,
              modelAttempts: this.assembled.modelAttempts,
              scope: {
                agentId: this.id,
                sessionId: this.id,
                cwd: this.assembled.childManager.cwd,
                runId: origin!.runId,
                inputId: origin!.inputId ?? origin!.runId,
                traceId: origin!.traceId ?? origin!.runId,
                signal: origin!.signal ? AbortSignal.any([controller.signal, origin!.signal]) : controller.signal,
              },
              emit:
                options.execution.emit ??
                (async (event) => {
                  await this.assembled.eventBus.emit(event, {
                    agentId: this.id,
                    sessionId: this.id,
                    runId: origin!.runId,
                    ...(origin!.inputId ? { inputId: origin!.inputId } : {}),
                    ...(origin!.traceId ? { traceId: origin!.traceId } : {}),
                  });
                }),
            }
          : undefined,
      );
    }, controller);
  }
  getCapabilities(): AgentCapabilitySnapshot {
    return toAgentCapabilitySnapshot(this.assembled.capabilities);
  }
  inspect(): AgentInspection {
    return {
      model: this.model,
      tools: this.runtime.toolRegistry.getAll().flatMap((tool) => {
        const inspection = this.runtime.toolRegistry.inspect(tool.name);
        return inspection ? [inspection] : [];
      }),
      hooks: (
        ("getAll" in this.runtime.hookExecutor
          ? (
              this.runtime
                .hookExecutor as import("@vykor/host-config").RegisteredHookExecutor
            ).getAll?.()
          : []) ?? []
      ).map((hook) => ({
        id: hook.id,
        event: hook.event,
        type: hook.type,
        enabled: hook.enabled,
      })),
      mcpServers: this.assembled.mcpConnections().map(toMcpInspection),
      childBudget: this.assembled.childManager.getBudgetSnapshot(),
      capabilities: this.getCapabilities(),
      ...(this.runtime.sandboxStatus
        ? { sandbox: this.runtime.sandboxStatus }
        : {}),
    };
  }
  listModelVisibleTools(): ModelVisibleTool[] {
    return this.runtime.toolRegistry.getAll().map((tool) => {
      const inspection = this.runtime.toolRegistry.inspect(tool.name);
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.safeToRetry === undefined
          ? {}
          : { safeToRetry: tool.safeToRetry }),
        source: inspection?.source ?? { kind: "runtime" },
      };
    });
  }
  private async runPluginAppTool(
    value: PluginAppHostInvocation,
    options: Omit<VykorAgentRunToolOptions, "tools">,
  ): Promise<ToolExecutionResult> {
    const invocation: PluginAppHostInvocation = { binding: structuredClone(value.binding), lease: structuredClone(value.lease),
      toolName: value.toolName, args: copyPluginAppJson(value.args, PLUGIN_APP_DATA_LIMITS.maxArgsBytes) as PluginAppHostInvocation["args"] };
    if (!invocation.args || Array.isArray(invocation.args) || typeof invocation.args !== "object") throw new PluginAppValidationError("plugin_app_invalid_request");
    const app = invocation.binding;
    if (
      app.agentId !== this.id ||
      app.sessionId !== this.id ||
      options.scope.sessionId !== this.id ||
      options.scope.agentId !== this.id
    )
      throw new Error("plugin_app_scope_invalid");
    const prepared = await this.appRuntime.prepare(
      invocation,
      this.createRunCapabilityView(app.pluginId),
    );
    const toolUse: ToolUseBlock = {
      type: "tool_use",
      id: `app_tool_${options.scope.runId}`,
      name: prepared.name,
      input: invocation.args,
    };
    const savedArgs = structuredClone(invocation.args),
      savedInvocation = structuredClone(invocation);
    const candidate = this.getPluginCandidates().find(
      (c) => c.pluginId === app.pluginId,
    );
    const release = this.assembled.retainMcpConnectionsForRun?.() ?? (() => {});
    try {
      if (candidate)
        await this.validatePluginScope(
          [candidate],
          options.signal ?? options.scope.signal,
        );
      return await this.runTool(toolUse, {
        ...options,
        tools: readonlyMap([[prepared.name, prepared.binding]]),
        confirmTool: async (input) => {
          if (
            !isDeepStrictEqual(value.binding, savedInvocation.binding) ||
            !isDeepStrictEqual(value.lease, savedInvocation.lease) ||
            value.toolName !== savedInvocation.toolName ||
            prepared.policy.confirmation !== "granted" ||
            input.scope.runId !== options.scope.runId ||
            input.scope.sessionId !== this.id ||
            input.scope.agentId !== this.id ||
            input.toolUse.id !== toolUse.id ||
            input.toolUse.name !== prepared.name ||
            input.binding.definitionIdentity !==
              prepared.binding.definitionIdentity ||
            input.binding.definition.execute !==
              prepared.binding.definition.execute ||
            !isDeepStrictEqual(input.toolUse.input, savedArgs)
          )
            return false;
          const fresh = await this.appRuntime.prepare(
            savedInvocation,
            this.createRunCapabilityView(savedInvocation.binding.pluginId),
          );
          return (
            fresh.policy.confirmation === "granted" &&
            fresh.binding.definitionIdentity ===
              prepared.binding.definitionIdentity &&
            fresh.binding.definition.execute ===
              prepared.binding.definition.execute &&
            isDeepStrictEqual(fresh.policy, prepared.policy)
          );
        },
        onToolEvent: async (event) => {
          if (
            event.type === "domain.event" &&
            event.data.name === "tool.lifecycle" &&
            event.data.payload?.phase === "running"
          )
            await this.appRuntime.host.assertTool(savedInvocation);
          await options.onToolEvent?.(event);
        },
      });
    } finally {
      release();
    }
  }
}
export function createAssembledAgent(
  options: AssembledAgentOptions,
): DefaultNodeAgent {
  return new NodeAgent(options);
}
function toMcpInspection(
  connection: McpConnection,
): AgentInspection["mcpServers"][number] {
  return {
    name: connection.name,
    status: connection.status,
    toolCount: connection.tools.length,
    resourceCount: connection.resources.length,
    command: connection.config.command
      ? `${connection.config.command} ${(connection.config.args ?? []).join(" ")}`.trim()
      : connection.config.url,
    ...(connection.error ? { error: connection.error.message } : {}),
  };
}
