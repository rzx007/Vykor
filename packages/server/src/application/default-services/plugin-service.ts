import { getInstalledPluginStorePath } from "@openharness/core";
import { getNativeToolRuntimeSnapshot } from "@openharness/agent-runtime";
import {
  installLocalNativePlugin,
  loadNativePlugin,
  readInstalledPluginStore,
  requestedPluginPermissions,
  updateInstalledPluginStore,
  validateNativePlugin,
  verifyInstalledNativePlugin,
  type InstalledPluginRecord,
  type InstalledPluginStoreV1,
} from "@openharness/plugins";
import { resolveLocalPluginZip, type ResolvedLocalPluginZip } from "@openharness/plugin-sources";
import type { PluginArchiveError, PluginArchivePreview, PluginInfo, PluginService } from "../settings-api.js";
import type { DaemonSettingsRef } from "./shared.js";

function isGlobalPlugin<T extends { scope: string }>(record: T): record is T & { scope: "user" | "managed" } {
  return record.scope === "user" || record.scope === "managed";
}

export class PluginArchiveFailure extends Error {
  constructor(readonly body: PluginArchiveError) {
    super(body.message);
    this.name = "PluginArchiveFailure";
  }
}

function archiveFailure(
  code: string,
  message: string,
  diagnostics?: PluginArchiveError["diagnostics"],
): PluginArchiveFailure {
  return new PluginArchiveFailure({ code, message, ...(diagnostics?.length ? { diagnostics } : {}) });
}

function archiveDiagnostic(code: string, message: string): NonNullable<PluginArchiveError["diagnostics"]>[number] {
  return { severity: "error", phase: "install", code, message };
}

function findUserPluginRecord(
  store: InstalledPluginStoreV1,
  pluginId: string,
): InstalledPluginRecord | undefined {
  return Object.values(store.plugins).find(
    (record) => record.scope === "user" && record.id === pluginId,
  );
}

function permissionsCovered(requested: string[], approved: string[]): boolean {
  const approvedSet = new Set(approved);
  return requested.every((permission) => approvedSet.has(permission));
}

function permissionSetsEqual(left: string[], right: string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((permission, index) => permission === normalizedRight[index]);
}

async function inspectArchive(resolved: ResolvedLocalPluginZip): Promise<PluginArchivePreview> {
  const validation = await validateNativePlugin(resolved.candidateRoot);
  if (validation.status !== "valid" || !validation.plugin) {
    throw archiveFailure("plugin_archive_invalid", "The plugin archive failed Native validation.", validation.diagnostics);
  }
  const loaded = await loadNativePlugin(validation.plugin);
  const diagnostics = [...validation.diagnostics, ...loaded.diagnostics];
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw archiveFailure("plugin_archive_invalid", "The plugin archive has invalid components.", diagnostics);
  }
  const inventory: Record<string, number> = {};
  for (const [kind, values] of Object.entries(validation.plugin.manifest.components)) {
    inventory[kind] = values.length;
  }
  const requestedPermissions = requestedPluginPermissions(validation.plugin.manifest);
  const store = await readInstalledPluginStore(getInstalledPluginStorePath());
  const previous = findUserPluginRecord(store, validation.plugin.manifest.id);
  return {
    archiveDigest: resolved.archiveDigest,
    identity: {
      id: validation.plugin.manifest.id,
      name: validation.plugin.manifest.name,
      version: validation.plugin.manifest.version,
      ...(validation.plugin.manifest.displayName ? { displayName: validation.plugin.manifest.displayName } : {}),
    },
    requestedPermissions,
    approvalRequired: requestedPermissions.length > 0
      && !permissionsCovered(requestedPermissions, previous?.approvedPermissions ?? []),
    inventory,
    diagnostics,
  };
}

async function withArchive<T>(
  archivePath: string,
  operation: (resolved: ResolvedLocalPluginZip) => Promise<T>,
): Promise<T> {
  let resolved: ResolvedLocalPluginZip | undefined;
  try {
    resolved = await resolveLocalPluginZip(archivePath);
    return await operation(resolved);
  } catch (error) {
    if (error instanceof PluginArchiveFailure) throw error;
    throw archiveFailure("plugin_archive_invalid", "The plugin archive could not be read.", [
      archiveDiagnostic("plugin_archive_resolution_failed", error instanceof Error ? error.message : String(error)),
    ]);
  } finally {
    await resolved?.cleanup();
  }
}

function assertExactPermissionSet(requested: string[], approvedPermissions: string[]): void {
  const approved = [...new Set(approvedPermissions)].sort();
  const missing = requested.filter((permission) => !approved.includes(permission));
  const unknown = approved.filter((permission) => !requested.includes(permission));
  if (missing.length || unknown.length) {
    throw archiveFailure("plugin_archive_permissions_not_approved", "Approved permissions must exactly match the archive request.", [
      {
        severity: "error",
        phase: "install",
        code: "plugin_permissions_not_approved",
        message: `Permission approval mismatch; missing=[${missing.join(", ")}], unknown=[${unknown.join(", ")}]`,
      },
    ]);
  }
}

export function createDefaultPluginService(_ref: DaemonSettingsRef): PluginService {
  return {
    async list() {
      const store = await readInstalledPluginStore(getInstalledPluginStorePath());
      const plugins: PluginInfo[] = [];
      const warnings: string[] = [];
      for (const record of Object.values(store.plugins)) {
        if (!isGlobalPlugin(record)) {
          warnings.push(`${record.id}: ignored legacy ${record.scope}-scoped installation; reinstall it for the user`);
          continue;
        }
        const verification = await verifyInstalledNativePlugin(record);
        const manifest = verification.plugin?.manifest;
        const loaded = verification.status === "valid" ? await loadNativePlugin(verification.plugin) : undefined;
        const liveTools = getNativeToolRuntimeSnapshot(verification.plugin?.root ?? record.cachePath);
        const inventory: Record<string, number> = {};
        if (manifest) for (const [kind, values] of Object.entries(manifest.components)) inventory[kind] = values.length;
        plugins.push({
          identity: {
            id: record.id,
            name: manifest?.name ?? record.id,
            version: manifest?.version ?? record.currentVersion,
            ...(manifest?.displayName ? { displayName: manifest.displayName } : {}),
          },
          origin: record.origin,
          ...(record.sourceFormat ? { sourceFormat: record.sourceFormat } : {}),
          scope: record.scope,
          enabled: record.enabled,
          installation: verification.status === "valid" ? "installed" : "invalid",
          activation: record.enabled ? "reload-required" : "inactive",
          ...(manifest?.components.tools ? {
            toolRuntime: {
              state: !record.enabled
                ? "inactive" as const
                : liveTools.hostCount > 0 ? liveTools.state : "reload-required" as const,
              declaredEntries: manifest.components.tools.length,
              activatableEntries: loaded?.components.tools?.value?.length ?? 0,
              hostCount: liveTools.hostCount,
              registeredToolCount: liveTools.registeredToolCount,
              ...(liveTools.lastStartedAt ? { lastStartedAt: liveTools.lastStartedAt } : {}),
              ...(liveTools.lastError ? { lastError: liveTools.lastError } : {}),
            },
          } : {}),
          runtimeStatus: record.enabled
            ? { state: "pending_reload", message: "插件将在下次运行时重新加载。", action: "reload" }
            : { state: "disabled", message: "插件已停用。", action: "enable" },
          inventory,
          permissions: {
            requested: record.requestedPermissions,
            approved: record.approvedPermissions,
            missing: record.requestedPermissions.filter((item) => !record.approvedPermissions.includes(item)),
          },
          diagnostics: [...verification.diagnostics, ...(loaded?.diagnostics ?? [])],
        });
      }
      return { plugins, warnings };
    },
    async setEnabled({ id, enabled }) {
      let changed = false;
      await updateInstalledPluginStore(getInstalledPluginStorePath(), (store) => {
        for (const record of Object.values(store.plugins)) {
          if (record.id !== id || !isGlobalPlugin(record)) continue;
          if (record.scope === "managed") throw new Error(`Managed plugin cannot be modified: ${id}`);
          record.enabled = enabled;
          record.updatedAt = new Date().toISOString();
          changed = true;
        }
        if (!changed) throw new Error(`Plugin not found for user: ${id}`);
      });
      return { message: `${enabled ? "Enabled" : "Disabled"} plugin '${id}'.`, restartRuntimes: true };
    },
    async installLocal(input) {
      const result = await installLocalNativePlugin(input);
      if (result.status !== "installed") throw new Error(result.diagnostics.map((item) => item.message).join("; "));
      return { message: `Installed plugin '${result.record.id}'.`, restartRuntimes: true };
    },
    async previewArchive({ archivePath }) {
      return await withArchive(archivePath, inspectArchive);
    },
    async installArchive({ archivePath, expectedArchiveDigest, approvedPermissions, cwd }) {
      return await withArchive(archivePath, async (resolved) => {
        const preview = await inspectArchive(resolved);
        if (preview.archiveDigest !== expectedArchiveDigest) {
          throw archiveFailure("plugin_archive_changed", "The plugin archive changed after preview. Select it again.");
        }
        const store = await readInstalledPluginStore(getInstalledPluginStorePath());
        if (Object.values(store.plugins).some((record) => record.scope === "managed" && record.id === preview.identity.id)) {
          throw archiveFailure("plugin_archive_managed_conflict", `Managed plugin cannot be replaced: ${preview.identity.id}`);
        }
        const previous = findUserPluginRecord(store, preview.identity.id);
        const submittedPermissions = [...new Set(approvedPermissions)].sort();
        const explicitlyApproved = permissionSetsEqual(submittedPermissions, preview.requestedPermissions);
        const reusedApproval = submittedPermissions.length === 0
          && permissionsCovered(preview.requestedPermissions, previous?.approvedPermissions ?? []);
        if (!explicitlyApproved && !reusedApproval) {
          assertExactPermissionSet(preview.requestedPermissions, submittedPermissions);
        }
        const effectiveApprovals = [...preview.requestedPermissions];
        let result;
        try {
          result = await installLocalNativePlugin({
            cwd,
            sourcePath: resolved.candidateRoot,
            scope: "user",
            approvedPermissions: effectiveApprovals,
          });
        } catch (error) {
          throw archiveFailure("plugin_archive_install_failed", "The plugin archive could not be installed.", [
            archiveDiagnostic("plugin_archive_install_failed", error instanceof Error ? error.message : String(error)),
          ]);
        }
        if (result.status !== "installed") {
          throw archiveFailure("plugin_archive_install_failed", "The plugin archive could not be installed.", result.diagnostics);
        }
        return { message: `Installed plugin '${result.record.id}'.` };
      });
    },
    async uninstall({ id }) {
      let changed = false;
      await updateInstalledPluginStore(getInstalledPluginStorePath(), (store) => {
        for (const [key, record] of Object.entries(store.plugins)) {
          if (record.id !== id || !isGlobalPlugin(record)) continue;
          if (record.scope === "managed") throw new Error(`Managed plugin cannot be removed: ${id}`);
          delete store.plugins[key];
          changed = true;
        }
        if (!changed) throw new Error(`Plugin not found for user: ${id}`);
      });
      return { message: `Uninstalled plugin '${id}' (plugin data retained).`, restartRuntimes: true };
    },
  };
}
