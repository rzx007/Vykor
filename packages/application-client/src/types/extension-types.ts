import type { MarketplaceProvenance } from "@vykor/protocol";

export type { MarketplaceCatalog, MarketplaceSource, MarketplaceSourceView, MarketplaceEntry, MarketplaceSelection, MarketplacePreview, MarketplaceInstallInput, MarketplaceOperation, MarketplaceProvenance } from "@vykor/protocol";

import type { PluginPresentation, PluginUiInventory } from "@vykor/protocol";

export type { PluginUiInventory } from "@vykor/protocol";

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
  provenance?: MarketplaceProvenance;
  identity: { id: string; name: string; version: string; displayName?: string };
  presentation?: PluginPresentation;
  origin: "native" | "converted";
  sourceFormat?: string;
  scope: "user" | "managed";
  enabled: boolean;
  installation: "installed" | "missing" | "invalid";
  activation: "inactive" | "active" | "partial" | "reload-required";
  /** Installed-state view. Live Tool Host state belongs to the owning Agent runtime. */
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
  uiInventory?: PluginUiInventory;
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
  replacementRequired?: boolean;
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
  replacementRequired?: boolean;
  inventory: Record<string, number>;
  diagnostics: PluginInfo["diagnostics"];
}

export interface PluginArchiveError {
  code: string;
  message: string;
  diagnostics?: PluginInfo["diagnostics"];
}

export interface HookInfo {
  id: string;
  event: string;
  type: string;
  enabled: boolean;
  origin: "settings" | "runtime";
}

export type { SkillSource, SkillInfo, SkillProject, SkillSnapshot, AgentPersonaInfo } from "@rzx/client";
