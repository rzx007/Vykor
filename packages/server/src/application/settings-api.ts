/**
 * Injectable daemon settings / provider surfaces.
 * Kept separate from slash-command registries — clients mutate via resource APIs.
 */

export interface SettingsService {
  agentEnvironmentCapabilities?(): Promise<
    import("@openharness/protocol").AgentEnvironmentCapabilities
  >;
  get(): Promise<Record<string, unknown>> | Record<string, unknown>;
  patch(patch: Record<string, unknown>):
    | Promise<{
        settings: Record<string, unknown>;
        restartRuntimes?: boolean;
        invalidateRuntimes?: boolean;
      }>
    | {
        settings: Record<string, unknown>;
        restartRuntimes?: boolean;
        invalidateRuntimes?: boolean;
      };
}

export interface ProviderInfo {
  name: string;
  displayName: string;
  hasKey: boolean;
  active: boolean;
  local?: boolean;
  custom?: boolean;
  requiresApiKey?: boolean;
  source?: "builtin" | "catalog" | "custom" | "subscription";
}

export interface CustomProviderModelInput {
  id: string;
  displayName: string;
  imageInputSupport?: InputSupport;
}

export interface CustomProviderInput {
  id: string;
  displayName: string;
  baseUrl: string;
  apiFormat: "openai";
  apiKey?: string;
  models: CustomProviderModelInput[];
  headers?: Record<string, string>;
}

export interface ProviderService {
  list(): Promise<ProviderInfo[]> | ProviderInfo[];
  create?(input: CustomProviderInput): Promise<ProviderInfo> | ProviderInfo;
  update?(
    id: string,
    input: CustomProviderInput,
  ): Promise<ProviderInfo> | ProviderInfo;
  remove?(id: string): Promise<void> | void;
  connectCatalog?(
    id: string,
    apiKey: string,
  ): Promise<ProviderInfo> | ProviderInfo;
  disconnectCatalog?(id: string): Promise<void> | void;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  providerName: string;
  hint?: string;
  contextWindow?: number;
  outputLimit?: number;
  reasoning?: boolean;
  vision?: boolean;
  inputModalities?: string[];
  inputCapabilities?: ModelInputCapabilities;
  toolCalling?: boolean;
  status?: "active" | "beta";
}

export interface ModelProviderInfo {
  name: string;
  displayName: string;
  models: ModelInfo[];
}

export interface ModelService {
  list(): Promise<ModelProviderInfo[]> | ModelProviderInfo[];
}

export interface McpServerStatus {
  name: string;
  status: string;
  toolCount: number;
  resourceCount: number;
  command?: string;
  error?: string;
}

export interface HookInfo {
  id: string;
  event: string;
  type: string;
  enabled: boolean;
  origin: "settings" | "runtime";
}

export interface MemoryEntryRecord {
  id: string;
  content: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MemoryService {
  list(input: {
    cwd: string;
  }):
    | Promise<{ directory: string; entries: MemoryEntryRecord[] }>
    | { directory: string; entries: MemoryEntryRecord[] };
  get(input: {
    cwd: string;
    id: string;
  }): Promise<MemoryEntryRecord | null> | MemoryEntryRecord | null;
  add(input: {
    cwd: string;
    content: string;
    tags?: string[];
  }): Promise<MemoryEntryRecord> | MemoryEntryRecord;
  remove(input: { cwd: string; id: string }): Promise<boolean> | boolean;
}

export interface AuthStatus {
  codex: {
    configured: boolean;
    state: string;
    source: string;
    detail?: string;
    profileLabel?: string;
  };
  storedProviders: string[];
  envProviders: Array<{ name: string; envKey: string }>;
}

export interface AuthService {
  status(): Promise<AuthStatus> | AuthStatus;
  login(input: {
    provider: string;
    apiKey?: string;
  }): Promise<{ message: string }> | { message: string };
  logout(input: {
    provider: string;
  }): Promise<{ message: string }> | { message: string };
}

export interface ContextService {
  plugins?(input: { cwd: string }): Promise<{ plugins: import("@openharness/protocol").PluginCatalogEntry[] }>;
  preview(input: {
    cwd: string;
  }): Promise<{ report: string }> | { report: string };
  status(input: {
    cwd: string;
  }): Promise<{ report: string }> | { report: string };
  usage(input: {
    cwd: string;
    sessionId?: string;
    refresh?: boolean;
    previousContextWindow?: number;
  }): Promise<{
    snapshot: import("@openharness/core").ContextUsageSnapshot;
    report: string;
  }>;
}

export interface DreamStartResult {
  started: boolean;
  taskId?: string;
  reason?: string;
}

export interface DreamService {
  start(input: {
    cwd: string;
    sessionId?: string;
    preview?: boolean;
  }): Promise<DreamStartResult> | DreamStartResult;
}

export interface ProfileService {
  status(): Promise<{ report: string }> | { report: string };
  init(): Promise<{ report: string }> | { report: string };
}

export interface OutputStyleInfo {
  name: string;
  content: string;
  source: "builtin" | "user";
}

export interface OutputStyleService {
  list(): Promise<OutputStyleInfo[]> | OutputStyleInfo[];
}

export interface ProjectInitService {
  init(input: {
    cwd: string;
  }): Promise<{ report: string }> | { report: string };
}

export type PluginRuntimeStatus =
  | { state: "disabled"; message: string; action: "enable" }
  | { state: "pending_reload"; message: string; action: "reload" }
  | { state: "loaded"; message: string; action: "none" }
  | {
      state: "degraded";
      code: string;
      message: string;
      action: "details" | "reimport" | "approve" | "disable";
    }
  | {
      state: "failed";
      code: string;
      message: string;
      action: "reimport" | "approve" | "disable" | "uninstall";
    };

export interface PluginInfo {
  identity: { id: string; name: string; version: string; displayName?: string };
  origin: "native" | "converted";
  sourceFormat?: string;
  scope: "user" | "managed";
  enabled: boolean;
  installation: "installed" | "missing" | "invalid";
  activation: "inactive" | "active" | "partial" | "reload-required";
  toolRuntime?: {
    state:
      | "inactive"
      | "reload-required"
      | "starting"
      | "active"
      | "degraded"
      | "error";
    declaredEntries: number;
    activatableEntries: number;
    hostCount: number;
    registeredToolCount: number;
    lastStartedAt?: string;
    lastError?: string;
  };
  runtimeStatus: PluginRuntimeStatus;
  inventory: Record<string, number>;
  permissions: { requested: string[]; approved: string[]; missing: string[] };
  diagnostics: Array<{
    severity: "info" | "warning" | "error";
    phase: string;
    code: string;
    message: string;
    path?: string;
  }>;
}

export interface PluginArchivePreview {
  archiveDigest: string;
  identity: { id: string; name: string; version: string; displayName?: string };
  requestedPermissions: string[];
  approvalRequired: boolean;
  inventory: Record<string, number>;
  diagnostics: PluginInfo["diagnostics"];
}

export interface PluginGitPreview {
  sourceDigest: string;
  url: string;
  ref?: string;
  commit: string;
  identity: { id: string; name: string; version: string; displayName?: string };
  requestedPermissions: string[];
  approvalRequired: boolean;
  inventory: Record<string, number>;
  diagnostics: PluginInfo["diagnostics"];
}

export interface PluginArchiveError {
  code: string;
  message: string;
  diagnostics?: PluginInfo["diagnostics"];
}

export interface PluginService {
  list(input: {
    cwd: string;
  }):
    | Promise<{ plugins: PluginInfo[]; warnings: string[] }>
    | { plugins: PluginInfo[]; warnings: string[] };
  setEnabled(input: {
    id: string;
    cwd: string;
    enabled: boolean;
  }):
    | Promise<{ message: string; restartRuntimes?: boolean }>
    | { message: string; restartRuntimes?: boolean };
  installLocal?(input: {
    cwd: string;
    sourcePath: string;
    scope: "user";
    approvedPermissions: string[];
    link?: boolean;
  }): Promise<{ message: string; restartRuntimes?: boolean }>;
  previewArchive?(input: {
    cwd: string;
    archivePath: string;
  }): Promise<PluginArchivePreview>;
  installArchive?(input: {
    cwd: string;
    archivePath: string;
    expectedArchiveDigest: string;
    approvedPermissions: string[];
  }): Promise<{ message: string }>;
  previewGit?(input: {
    cwd: string;
    url: string;
    ref?: string;
  }): Promise<PluginGitPreview>;
  installGit?(input: {
    cwd: string;
    url: string;
    ref?: string;
    expectedSourceDigest: string;
    approvedPermissions: string[];
  }): Promise<{ message: string }>;
  uninstall?(input: {
    cwd: string;
    id: string;
  }): Promise<{ message: string; restartRuntimes?: boolean }>;
}

export type SkillSource =
  "bundled" | "agent" | "standard" | "project" | "personal";
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  content: string;
  path: string;
  source: SkillSource;
  readOnly: boolean;
  projectPath?: string;
  projectName?: string;
}
export interface SkillProject {
  name: string;
  path: string;
}
export interface SkillSnapshot {
  skills: SkillInfo[];
  projects: SkillProject[];
  warnings: string[];
}
export interface SkillService {
  list(): Promise<SkillSnapshot> | SkillSnapshot;
  remove(input: {
    id: string;
    expectedContent: string;
  }): Promise<SkillSnapshot> | SkillSnapshot;
}

export interface AgentPersonaInfo {
  name: string;
  description: string;
  source?: string;
  model?: string;
}

export interface AgentPersonaService {
  list():
    Promise<{ agents: AgentPersonaInfo[] }> | { agents: AgentPersonaInfo[] };
}

export interface HooksService {
  list(input: {
    cwd: string;
    sessionId?: string;
  }): Promise<{ hooks: HookInfo[] }> | { hooks: HookInfo[] };
}

export interface GitService {
  diff(input: {
    cwd: string;
    full?: boolean;
  }): Promise<{ output: string }> | { output: string };
  branch(input: {
    cwd: string;
    list?: boolean;
  }): Promise<{ output: string }> | { output: string };
  status(input: {
    cwd: string;
  }): Promise<{ output: string }> | { output: string };
  commit(input: {
    cwd: string;
    message: string;
  }): Promise<{ output: string }> | { output: string };
}
import type { InputSupport, ModelInputCapabilities } from "@openharness/core";
