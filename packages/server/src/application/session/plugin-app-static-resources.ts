import { selectPluginInstallationWinners } from "@vykor/agent-runtime";
import { computePluginBehaviorDigest, discoverInstalledNativePlugins, loadNativeAppMetadata,
  readPluginAppResource, verifyInstalledNativePlugin } from "@vykor/plugins";
import { PLUGIN_APP_HTML_MIME_TYPE, type PluginAppRecord, type SessionRecord } from "@vykor/protocol";

/** Offline Native HTML is independently readable with render approval; this never constructs tool authority. */
export async function verifiedStaticAppResources(session: SessionRecord, app: PluginAppRecord) {
  if (app.backendKind !== "native-tools") return undefined;
  const { winners } = selectPluginInstallationWinners(await discoverInstalledNativePlugins({ cwd: session.cwd }));
  const record = winners.find(item => item.id === app.pluginId);
  if (!record || !record.enabled || !record.approvedPermissions.includes("ui:render") || record.currentVersion !== app.pluginVersion) return undefined;
  const verified = await verifyInstalledNativePlugin(record);
  // Identity/cache shape/requested permissions were checked before this one permitted failure.
  // Missing invoke/tool permissions can only permit static HTML, never a runtime capture or lease.
  if (!verified.plugin || (verified.status !== "valid"
    && !verified.diagnostics.every(d => d.code === "plugin_permissions_not_approved"))) return undefined;
  const digest = await computePluginBehaviorDigest(verified.plugin.root);
  if (digest !== app.pluginDigest || (record.scope === "user" && !record.linkedSourcePath && digest !== record.behaviorDigest)) return undefined;
  const loaded = await loadNativeAppMetadata(verified.plugin);
  const metadata = loaded.value?.find(item => item.definitionDigest === app.definitionDigest);
  const backend = metadata?.definition.backends.find(item => item.id === app.backendId && item.kind === "native-tools");
  if (loaded.status !== "loaded" || !metadata || backend?.kind !== "native-tools"
    || !backend.resources.some(resource => resource.uri === app.resourceUri)) return undefined;
  const resources = metadata.resources.filter(resource => backend.resources.some(mapping => mapping.uri === resource.definition.uri));
  return {
    async readResource(uri: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const resource = resources.find(item => item.definition.uri === uri);
      if (!resource) throw new Error("plugin_app_resource_unavailable");
      const result = await readPluginAppResource(verified.plugin!.root, resource);
      signal?.throwIfAborted(); return result;
    },
    async listResources(cursor?: string) {
      if (cursor) throw new Error("plugin_app_invalid_cursor");
      return { resources: resources.map(resource => ({ uri: resource.definition.uri, name: resource.definition.uri, mimeType: PLUGIN_APP_HTML_MIME_TYPE })) };
    },
    async listResourceTemplates(cursor?: string) {
      if (cursor) throw new Error("plugin_app_invalid_cursor");
      return { resourceTemplates: [] };
    },
  };
}
