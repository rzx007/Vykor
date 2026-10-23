import type { PluginAppRecord } from "@vykor/domain-contracts/plugin-apps";
import type { PluginAppHostBinding, PluginAppHostInvocation, PluginAppRuntimeLease } from "@vykor/plugin-contracts/runtime";
import type { JsonValue } from "@vykor/json-data/json";
/** Build solely from the saved record; request/page fields never supply host identity. */
export function pluginAppHostBinding(app: PluginAppRecord, agentId = app.sessionId): PluginAppHostBinding {
  return { agentId, sessionId: app.sessionId, instanceId: app.id, pluginId: app.pluginId, pluginVersion: app.pluginVersion,
    pluginDigest: app.pluginDigest, definitionDigest: app.definitionDigest, backendId: app.backendId, backendKind: app.backendKind, resourceUri: app.resourceUri };
}
export function pluginAppHostInvocation(app: PluginAppRecord, request: { lease: PluginAppRuntimeLease; toolName: string; args: Record<string, JsonValue> }, agentId = app.sessionId): PluginAppHostInvocation {
  return { binding: pluginAppHostBinding(app, agentId), lease: request.lease, toolName: request.toolName, args: request.args };
}
