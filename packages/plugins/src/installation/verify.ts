import type { PluginDiagnostic } from "../diagnostics.js";
import type { ValidatedNativePlugin, VykorPluginManifestV1 } from "../types.js";
import { validateNativePlugin } from "../manifest/validate.js";
import { assertRegularPluginCacheSnapshot, computePluginBehaviorDigest } from "./cache.js";
import { requestedPluginPermissions } from "./installer.js";
import type { InstalledPluginRecord } from "./store.js";

export type InstalledNativePluginVerification =
  | { status: "valid"; plugin: ValidatedNativePlugin; diagnostics: [] }
  | { status: "invalid"; plugin?: ValidatedNativePlugin; rootManifest?: VykorPluginManifestV1; diagnostics: PluginDiagnostic[] };

function samePermissions(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((permission, index) => permission === normalizedRight[index]);
}

function invalid(
  record: InstalledPluginRecord,
  plugin: ValidatedNativePlugin | undefined,
  code: string,
  message: string,
): InstalledNativePluginVerification {
  return {
    status: "invalid",
    ...(plugin ? { plugin } : {}),
    diagnostics: [{ severity: "error", phase: "activate", code, message, pluginId: record.id }],
  };
}

export async function verifyInstalledNativePlugin(
  record: InstalledPluginRecord,
): Promise<InstalledNativePluginVerification> {
  const copiedUserInstallation = record.scope === "user" && !record.linkedSourcePath;
  if (copiedUserInstallation) {
    if (!record.behaviorDigest) {
      return invalid(
        record,
        undefined,
        "plugin_content_digest_missing",
        "copied plugin installation has no trusted content digest; reinstall the plugin",
      );
    }
    try {
      await assertRegularPluginCacheSnapshot(record.cachePath);
    } catch {
      return invalid(
        record,
        undefined,
        "plugin_cache_snapshot_invalid",
        "copied plugin cache snapshot is not a regular directory; reinstall the plugin",
      );
    }
  }

  const validation = await validateNativePlugin(record.cachePath);
  if (validation.status !== "valid" || !validation.plugin) return {
    status: "invalid", diagnostics: validation.diagnostics,
    ...(validation.rootManifest ? { rootManifest: validation.rootManifest } : {}),
  };
  const plugin = validation.plugin;
  const manifest = plugin.manifest;
  if (manifest.id !== record.id || manifest.version !== record.currentVersion) {
    return invalid(
      record,
      plugin,
      "plugin_installation_identity_mismatch",
      `actual plugin identity ${manifest.id}@${manifest.version} differs from installed identity ${record.id}@${record.currentVersion}; reinstall the plugin`,
    );
  }
  const actualPermissions = requestedPluginPermissions(manifest);
  if (!samePermissions(actualPermissions, record.requestedPermissions)) {
    return invalid(
      record,
      plugin,
      "plugin_installation_permissions_mismatch",
      `actual plugin permissions [${actualPermissions.join(", ")}] differ from the installed permission request [${record.requestedPermissions.join(", ")}]; reinstall the plugin`,
    );
  }
  const missingPermissions = actualPermissions.filter((permission) => !record.approvedPermissions.includes(permission));
  if (missingPermissions.length > 0) {
    return invalid(
      record,
      plugin,
      "plugin_permissions_not_approved",
      `missing approved plugin permissions [${missingPermissions.join(", ")}]; approve the permissions or reinstall the plugin before it can run`,
    );
  }
  if (copiedUserInstallation) {
    try {
      if (await computePluginBehaviorDigest(record.cachePath) !== record.behaviorDigest!) {
        return invalid(
          record,
          plugin,
          "plugin_content_digest_mismatch",
          "cached plugin content does not match the installed digest; reinstall the plugin",
        );
      }
    } catch (error) {
      return invalid(
        record,
        plugin,
        "plugin_content_digest_verification_failed",
        `could not verify cached plugin content: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { status: "valid", plugin, diagnostics: [] };
}
