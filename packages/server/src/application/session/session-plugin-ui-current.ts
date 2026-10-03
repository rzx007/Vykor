import { lstat } from "node:fs/promises";
import { selectPluginInstallationWinners, type VykorAgent } from "@vykor/agent-runtime";
import type { Settings } from "@vykor/core";
import { computePluginBehaviorDigest, discoverInstalledNativePlugins, loadNativeUiMetadata,
  readNativeUiDocument, verifyInstalledNativePlugin } from "@vykor/plugins";
import { readSessionRuntimeConfig, type PluginUiInstanceRecord, type SessionRecord } from "@vykor/protocol";
import type { PluginUiCurrentState } from "./session-plugin-ui-service.js";

/** Resolve from installation files on every read/admission, never from an old availability claim. */
export async function resolveSessionPluginUiCurrent(
  session: SessionRecord, instance: PluginUiInstanceRecord,
  options: { settings?: Settings; acquireSession(sessionId: string): Promise<Pick<VykorAgent, "createRunCapabilityView">> },
): Promise<PluginUiCurrentState> {
  const current: PluginUiCurrentState = { enabled: false, uiEnabled: options.settings?.plugins?.enabled ?? true,
    permissionsApproved: false, snapshot: "missing", runtimeAvailable: false };
  if (!current.uiEnabled || readSessionRuntimeConfig(session).pluginsEnabled === false) return current;
  const { winners } = selectPluginInstallationWinners(await discoverInstalledNativePlugins({ cwd: session.cwd }));
  const record = winners.find(candidate => candidate.id === instance.pluginId);
  if (!record) return current;
  current.enabled = true;
  current.permissionsApproved = ["ui:render", "ui:invoke-own-tools", ...record.requestedPermissions]
    .every(permission => record.approvedPermissions.includes(permission));
  if (!current.permissionsApproved) return current;
  try { await lstat(record.cachePath); } catch { return current; }
  current.snapshot = "changed";
  const verified = await verifyInstalledNativePlugin(record);
  if (verified.status !== "valid") {
    if (verified.diagnostics.some(d => d.code === "plugin_permissions_not_approved" || d.code === "plugin_installation_permissions_mismatch")) current.permissionsApproved = false;
    return current;
  }
  const digest = await computePluginBehaviorDigest(verified.plugin.root);
  if (record.currentVersion !== instance.pluginVersion || digest !== instance.pluginDigest) return current;
  const loaded = await loadNativeUiMetadata(verified.plugin);
  const component = loaded.value?.find(candidate => candidate.definition.id === instance.componentId);
  current.snapshot = "valid";
  if (!component || loaded.status !== "loaded") return current;
  current.documentBinding = { pluginId: record.id, pluginVersion: record.currentVersion, pluginDigest: digest,
    componentId: component.definition.id, componentDigest: component.componentDigest, definition: component.definition };
  if (component.componentDigest !== instance.componentDigest) { current.snapshot = "changed"; return current; }
  try { current.document = await readNativeUiDocument(verified.plugin.root, component); }
  catch { current.snapshot = "changed"; return current; }
  // No executable binding is reconstructed from static files. An unavailable Host leaves actions empty.
  try {
    const agent = await options.acquireSession(session.id);
    const view = agent.createRunCapabilityView(record.id);
    current.binding = view.pluginUi?.get(`${record.id}:${component.definition.id}`);
    if (!current.binding) {
      // Preparation succeeded: a missing/filtered/foreign action is an invalid definition,
      // unlike a Host failure caught below. Do not authorize its document.
      current.documentBinding = undefined;
      current.document = undefined;
      return current;
    }
    if (current.binding && (current.binding.pluginDigest !== digest || current.binding.componentDigest !== component.componentDigest
      || current.binding.pluginVersion !== record.currentVersion)) { current.snapshot = "changed"; return current; }
    current.runtimeAvailable = current.binding !== undefined;
  } catch { /* Exact verified static snapshot remains readable. */ }
  return current;
}
