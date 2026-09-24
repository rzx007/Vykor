import type { PluginDiagnostic } from "./diagnostics.js";
import type { HookDefinition, McpServerConfig } from "@vykor/core";
import type { AgentDefinition } from "@vykor/coordinator";
import type { SkillDefinition } from "@vykor/skills";

export const NATIVE_PLUGIN_COMPONENT_KINDS = [
  "skills", "agents", "hooks", "mcpServers", "lspServers", "tools", "workflows",
  "channels", "providers", "ui", "outputStyles", "themes", "monitors", "binaries",
] as const;

export type NativePluginComponentKind = (typeof NATIVE_PLUGIN_COMPONENT_KINDS)[number];

export interface NativeToolComponent {
  entry: string;
  runtime?: "node" | "wasm";
  permissions?: string[];
}

export interface NativeToolMetadata {
  /** Manifest-relative entry kept for diagnostics and display. */
  declaredEntry: string;
  /** Canonical absolute entry path. Only the isolated Tool Host may import it. */
  entryPath: string;
  runtime: "node" | "wasm";
  requestedPermissions: string[];
  effectivePermissions: VykorPluginPermissions;
}

export interface VykorPluginComponents {
  skills?: string[];
  agents?: string[];
  hooks?: string[];
  mcpServers?: string[];
  lspServers?: string[];
  tools?: Array<string | NativeToolComponent>;
  workflows?: string[];
  channels?: string[];
  providers?: string[];
  ui?: string[];
  outputStyles?: string[];
  themes?: string[];
  monitors?: string[];
  binaries?: string[];
}

export interface VykorPluginPermissions {
  filesystem?: string[];
  network?: string[];
  process?: string[];
  secrets?: string[];
}

export interface VykorPluginRuntime {
  engine: "node" | "wasm";
  isolation: "worker" | "process";
}

export interface VykorPluginManifestV1 {
  $schema?: string;
  schemaVersion: 1;
  id: string;
  name: string;
  displayName?: string;
  version: string;
  description?: string;
  author?: { name: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  metadata?: Record<string, unknown>;
  components: VykorPluginComponents;
  permissions?: VykorPluginPermissions;
  runtime?: VykorPluginRuntime;
}

export interface ValidatedNativePlugin {
  root: string;
  manifestPath: string;
  manifest: VykorPluginManifestV1;
}

export interface NativePluginValidationResult {
  status: "valid" | "invalid";
  plugin?: ValidatedNativePlugin;
  diagnostics: PluginDiagnostic[];
}

export interface PluginComponentResult<T> {
  status: "loaded" | "unsupported" | "invalid" | "blocked";
  value?: T;
  diagnostics: PluginDiagnostic[];
}

export interface NativePluginComponents {
  skills?: PluginComponentResult<SkillDefinition[]>;
  agents?: PluginComponentResult<AgentDefinition[]>;
  hooks?: PluginComponentResult<HookDefinition[]>;
  mcpServers?: PluginComponentResult<Record<string, McpServerConfig>>;
  tools?: PluginComponentResult<NativeToolMetadata[]>;
  unsupported?: Partial<Record<NativePluginComponentKind, PluginComponentResult<never>>>;
}

export interface LoadedNativePlugin {
  manifest: VykorPluginManifestV1;
  root: string;
  status: "loaded" | "degraded";
  components: NativePluginComponents;
  diagnostics: PluginDiagnostic[];
}
