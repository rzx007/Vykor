export { AgentChildBudgetExceededError } from "@vykor/agent-contracts";
export { AgentRunNotAcceptingInputError } from "@vykor/agent-contracts";
export { assertSupportedOutputSchema } from "./kernel/delivery/schema.js";
export {
  AgentOperationConflictError,
  type AgentCompactResult,
  type AgentInspection,
  type DefaultNodeAgent,
  type NodeAgentHost,
  type HostedAgent,
  type ModelVisibleTool,
  type VykorAgent,
  type VykorAgentOptions,
  type VykorAgentState,
  type VykorAgentSubmitOptions,
  type VykorAgentRunToolOptions,
} from "./node/agent/agent.js";
export type { PluginSelectionCandidate, PluginSelectionCatalog, PluginSelectionResult } from "./node/plugins/plugin-selection.js";
export { renderPluginDiscoveryContext } from "./node/plugins/plugin-discovery-context.js";
export { createDefaultNodeAgent, type DefaultNodeAgentOptions } from "./node/agent/default-agent.js";
export { createConfiguredApprovalReviewer, type ConfiguredApprovalReviewerOptions } from "./node/review/configured-approval-reviewer.js";
export { createRunCapabilityView, PluginPreparationError, type RunCapabilitySources } from "./node/plugins/run-capability-view.js";
export { createCompactContextProvider, type CompactContextSources } from "./node/memory/compact-context.js";
export type {
  AgentCapabilityOverrides,
  AgentEffectOverrides,
  AgentRunCapabilitySnapshot,
  CapabilityOverride,
  ObservableJobProducer,
  VykorAgentConfiguration,
} from "./node/agent/agent-options.js";
export {
  assertJobConfiguration,
  disabledCapability,
  resolveCapability,
  toAgentCapabilitySnapshot,
  toCapabilitySnapshot,
  unavailableCapability,
  type AgentCapabilitySnapshot,
  type CapabilitySnapshot,
  type ResolvedAgentCapabilities,
  type ResolvedCapability,
} from "./node/capabilities/capability-resolution.js";
export {
  createAgentKernel,
  createBasicAgentKernelRuntime,
  type BasicAgentKernelRuntimeOptions,
  type AgentKernelOptions,
  type AgentKernelRuntime,
  type AgentKernelRuntimeContext,
} from "./kernel/index.js";
export type { AgentRememberResult, AgentRememberOptions, AgentMemoryExecution } from "./node/memory/memory-runtime.js";
export { createRememberTool, type RememberToolOptions } from "./node/memory/remember-tool.js";
export type { VykorAgentExtension, VykorExtensionContext } from "./node/plugins/extensions.js";
export { discoverVykorExtensions } from "./node/plugins/extensions.js";
export { activateDiscoveredPlugins, type ActivateDiscoveredPluginsOptions } from "./node/plugins/plugin-activation.js";
export {
  createPluginCapabilityInventory,
  pluginMcpServerId,
  pluginNativeToolEntryId,
  selectPluginInstallationWinners,
  type LoadedPluginInstallation,
  type PluginCapabilityInventory,
  type PluginCapabilityOwner,
} from "./node/plugins/plugin-capability-inventory.js";
export {
  activateNativePluginTools,
  type NativeToolActivationResult,
} from "./node/plugins/native-tools/activate.js";
export {
  NativeToolHost,
  NativeToolHostError,
  type NativeToolHostOptions,
  type NativeToolHostState,
} from "./node/plugins/native-tools/tool-host.js";
export {
  getNativeToolRuntimeSnapshot,
  type NativeToolRuntimeSnapshot,
} from "./node/plugins/native-tools/status.js";
export type { AgentChildEnvironmentLease, AgentChildEnvironmentProvider } from "./kernel/children/child-agent.js";
export type { PluginAppBackendPort, PluginAppBackendCatalogue, CapturedPluginAppBackend, PluginAppResultView } from "./node/plugin-apps/plugin-app-backends.js";
export { nativeToolResultToAppResult } from "./node/plugin-apps/native-plugin-app-backend.js";
export { mcpToolResultToAppResult } from "./node/plugin-apps/mcp-plugin-app-backend.js";
export {
  buildChildAgentWorktreeSlug,
  computeChildAgentWorktreeBaseDir,
  createChildAgentWorktreeManager,
  createDefaultChildEnvironmentProvider,
  createInProcessChildEnvironmentProvider,
  type ChildAgentWorktreeManager,
  type GitRunner,
} from "./node/children/child-environment.js";
export type { PluginAppRuntimeHost, PluginAppRuntimeFacts } from "./node/plugin-apps/plugin-app-runtime.js";

export { loadNodeAgentDefinitions } from "./node/definitions/definitions.js";
export * from "./node/workflow/index.js";

export { createDefaultToolRegistry } from "./node/tools/default-tool-registry.js";
export { LocalAgentJobHost, type LocalAgentJobHostOptions } from "./node/jobs/local-agent-job-host.js";

export type { RunCapabilityView, NodeRunToolBinding, RunSkillBinding, RunAgentBinding, RunMcpServerBinding, RuntimeSandboxStatus } from "./node/runtime/node-runtime-resources.js";
