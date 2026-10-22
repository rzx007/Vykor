import { getInstalledPluginStorePath, getPluginCacheDir } from "@vykor/host-config";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { validateNativePlugin } from "../manifest/validate.js";
import type { PluginDiagnostic, } from "../diagnostics.js";
import type { VykorPluginManifestV1 } from "../types.js";
import { computePluginBehaviorDigest, materializePluginCache } from "./cache.js";
import {
  installedPluginKey,
  updateInstalledPluginStore,
  readInstalledPluginStore,
  withPluginInstallationLock,
  prunePluginInstallOperations,
  type StoredPluginInstallOperation,
  type InstalledPluginRecord,
} from "./store.js";

export function requestedPluginPermissions(manifest: VykorPluginManifestV1): string[] {
  const result = new Set<string>();
  for (const [category, permissions] of Object.entries(manifest.permissions ?? {})) {
    for (const permission of permissions ?? []) result.add(`${category}:${permission}`);
  }
  for (const tool of manifest.components.tools ?? []) {
    if (typeof tool !== "string") for (const permission of tool.permissions ?? []) result.add(`tool:${permission}`);
  }
  if (manifest.components.ui?.length || manifest.components.apps?.length) {
    result.add("ui:render");
    result.add("ui:invoke-own-tools");
  }
  return [...result].sort();
}

export interface InstallLocalNativePluginInput {
  provenance?: import("@vykor/plugin-contracts/marketplace").MarketplaceProvenance;
  operation?: StoredPluginInstallOperation;
  allowSourceChange?: boolean;
  reuseApprovedPermissions?: boolean;
  /** Source coordinators revalidate revocation/expiry at the atomic publication boundary. */
  validateBeforeCommit?: () => Promise<void>;
  sourcePath: string;
  scope: "user";
  cwd: string;
  approvedPermissions: string[];
  cacheDir?: string;
  storePath?: string;
  origin?: "native" | "converted";
  sourceFormat?: string;
  link?: boolean;
}
export type InstallLocalNativePluginResult =
  | { status: "installed"; record: InstalledPluginRecord; diagnostics: PluginDiagnostic[] }
  | { status: "blocked" | "invalid"; diagnostics: PluginDiagnostic[] };

export async function installLocalNativePlugin(input: InstallLocalNativePluginInput): Promise<InstallLocalNativePluginResult> {
  return withPluginInstallationLock(input.storePath ?? getInstalledPluginStorePath(), () => installNativePlugin(input));
}
async function installNativePlugin(input: InstallLocalNativePluginInput): Promise<InstallLocalNativePluginResult> {
  const suppliedScope = (input as { scope?: unknown }).scope;
  if (suppliedScope !== "user") return { status: "blocked", diagnostics: [{
    severity: "error", phase: "install", code: "plugin_scope_not_supported",
    message: `Native Plugins can only be installed for the user; received scope '${String(suppliedScope)}'`,
  }] };
  const sourcePath = await realpath(resolve(input.sourcePath));
  const validation = await validateNativePlugin(sourcePath);
  if (validation.status === "invalid" || !validation.plugin) return { status: "invalid", diagnostics: validation.diagnostics };
  const requested = requestedPluginPermissions(validation.plugin.manifest);
  const approved = [...new Set(input.approvedPermissions)].sort();
  const unknown = approved.filter((permission) => !requested.includes(permission));
  const missing = requested.filter((permission) => !approved.includes(permission));
  if (unknown.length || missing.length) return { status: "blocked", diagnostics: [{
    severity: "error", phase: "install", code: "plugin_permissions_not_approved",
    message: `Permission approval mismatch; missing=[${missing.join(", ")}], unknown=[${unknown.join(", ")}]`,
    pluginId: validation.plugin.manifest.id, details: { requested, approved, missing, unknown },
  }] };

  const digest = await computePluginBehaviorDigest(sourcePath);
  const current = await readInstalledPluginStore(input.storePath ?? getInstalledPluginStorePath());
  const id = validation.plugin.manifest.id;
  if (Object.values(current.plugins).some(record => record.id === id && record.scope === "managed")) return { status: "blocked", diagnostics: [{ severity: "error", phase: "install", code: "plugin_managed_conflict", message: "Managed plugin cannot be replaced", pluginId: id }] };
  const previous = current.plugins[`user::${id}`];
  if (input.reuseApprovedPermissions && requested.some(permission => !previous?.approvedPermissions.includes(permission))) return { status: "blocked", diagnostics: [{ severity: "error", phase: "install", code: "plugin_permissions_not_approved", message: "Previously approved permissions were revoked; preview and approve again", pluginId: id }] };
  const sameSource = previous?.provenance?.sourceId === input.provenance?.sourceId && previous?.provenance?.catalogUrl === input.provenance?.catalogUrl;
  if (previous && (previous.provenance || input.provenance) && !sameSource && !input.allowSourceChange) return { status: "blocked", diagnostics: [{ severity: "error", phase: "install", code: "plugin_source_confirmation_required", message: "Changing plugin source requires explicit confirmation", pluginId: id }] };
  let cachePath = sourcePath;
  if (!input.link) {
    let candidateDiagnostics: PluginDiagnostic[] | undefined;
    try {
      cachePath = await materializePluginCache(
        sourcePath, input.cacheDir ?? getPluginCacheDir(), validation.plugin.manifest.id,
        validation.plugin.manifest.version,
        digest,
        async (candidatePath) => {
          const candidateValidation = await validateNativePlugin(candidatePath);
          if (candidateValidation.status === "invalid") {
            candidateDiagnostics = candidateValidation.diagnostics;
            throw new Error("Copied plugin cache failed Native validation");
          }
        },
      );
    } catch (error) {
      if (candidateDiagnostics) return { status: "invalid", diagnostics: candidateDiagnostics };
      throw error;
    }
  }

  const now = new Date().toISOString();
  const metadata = validation.plugin.manifest.metadata;
  const manifestOrigin = metadata?.origin === "converted" ? "converted" : "native";
  const manifestSourceFormat = typeof metadata?.sourceFormat === "string" ? metadata.sourceFormat : undefined;
  const record: InstalledPluginRecord = {
    ...(input.provenance ? { provenance: structuredClone(input.provenance) } : {}),
    id: validation.plugin.manifest.id, scope: input.scope,
    enabled: true, currentVersion: validation.plugin.manifest.version, cachePath,
    ...(!input.link ? { behaviorDigest: digest } : {}),
    ...(input.link ? { linkedSourcePath: sourcePath } : {}), origin: input.origin ?? manifestOrigin,
    ...((input.sourceFormat ?? manifestSourceFormat) ? { sourceFormat: input.sourceFormat ?? manifestSourceFormat } : {}),
    requestedPermissions: requested, approvedPermissions: approved, installedAt: now, updatedAt: now,
  };
  const key = installedPluginKey(record);
  const updatedStore = await updateInstalledPluginStore(input.storePath ?? getInstalledPluginStorePath(), async (store) => {
    await input.validateBeforeCommit?.();
    const previous = store.plugins[key];
    store.plugins[key] = previous
      ? { ...record, enabled: previous.enabled, installedAt: previous.installedAt }
      : record;
    if (input.operation) {
      store.installOperations ??= {};
      store.installOperations[input.operation.operationId] = { ...input.operation, status: "installed", updatedAt: now };
      prunePluginInstallOperations(store);
    }
  });
  return { status: "installed", record: updatedStore.plugins[key]!, diagnostics: [] };
}
