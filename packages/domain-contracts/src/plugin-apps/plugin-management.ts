import type { MarketplaceProvenance } from "@vykor/plugin-contracts/marketplace";
import type { PluginPresentation } from "@vykor/plugin-contracts/presentation";
import type { PluginUiInventory } from "./history.js";

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

export interface ReloadPluginsResponse {
  plugins: PluginInfo[];
  warnings: string[];
  message: string;
}
