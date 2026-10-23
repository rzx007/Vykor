export type {
  ResolvedSandboxConfig, SandboxAvailability, SandboxBackend, SandboxFailureKind,
  SandboxNetworkMode, SandboxOperation, SandboxPathValidationResult, SandboxPolicy,
  SandboxPolicyDenial, SandboxPolicyEnforcement, SandboxPolicyInput, SandboxPolicyMode,
  SandboxPolicyOperation, SandboxPolicyScope, SandboxPolicyService, SandboxPlatform,
  SandboxRuntimeEvent, SandboxRuntimeReporter, ShellSpawnOptions, ValidateSandboxPathOptions,
} from "./environment/types.js";
export { SandboxUnavailableError } from "./environment/errors.js";
export { normalizeSandboxConfig } from "./configuration/config.js";
export { settingsForApprovalMode } from "./policy/approval-policy.js";
export { ExecutionConfigError, resolveExecutionEnvironmentConfig } from "./configuration/execution-config.js";
export { createExecutionEnvironment } from "./environment/execution-environment.js";
export type { CreateExecutionEnvironmentDependencies, CreateExecutionEnvironmentInput } from "./environment/execution-environment.js";
export type { ExecutionSurface, ResolveExecutionEnvironmentConfigInput, ResolvedExecutionEnvironmentConfig } from "./configuration/execution-config.js";
export { classifySandboxFailure, defaultSandboxPolicyService, DefaultSandboxPolicyService, resolveSandboxPolicy, SandboxPolicyDeniedError } from "./policy/policy.js";
export { detectSandboxPlatform, supportsSandboxRuntime } from "./environment/platform.js";
export { validateSandboxPath } from "./policy/path-validator.js";
export { getSandboxAvailability, getSrtAvailability } from "./environment/availability.js";
export type { AvailabilityDeps } from "./environment/availability.js";
export { buildSrtRuntimeConfig, shellJoin, shellQuote, wrapCommandForSrt } from "./process/srt-adapter.js";
export type { SrtRuntimeConfig, WrappedSrtCommand } from "./process/srt-adapter.js";
export { registerManagedProcess, signalProcessTree, terminateProcessTree } from "./process/process-control.js";
export type { ProcessSignal } from "./process/process-control.js";
export { createProcess, createShellProcess, describeHostShellLauncher, resolveHostShellLauncher, resolveShellArgv, resolveShellDescriptor, resetHostShellCacheForTests } from "./process/shell.js";
export type { CreateProcessOptions, CreateShellProcessOptions, HostShellLauncher } from "./process/shell.js";
export { WslEnvironmentUnavailableError, createWslPathResolver, hostPathToWslPath, preflightWsl, spawnWslProcess, wslPathToHostPath } from "./environment/wsl-environment.js";
