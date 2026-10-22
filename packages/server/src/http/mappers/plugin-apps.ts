import type { PluginAppSource, PluginAppToolRequest, PluginAppConversationRequest } from "@vykor/protocol";
import type { PluginAppToolInput, PluginAppConversationInput } from "@vykor/domain-contracts/plugin-apps";

/** The checked route supplies identity; the request supplies only the operation fields. */
export function pluginAppToolInput(source: PluginAppSource, input: PluginAppToolRequest): PluginAppToolInput {
  return { source: { sessionId: source.sessionId, appId: source.appId },
    lease: { token: input.lease.token, backendGeneration: input.lease.backendGeneration },
    requestId: input.requestId, expectedRevision: input.expectedRevision, toolName: input.toolName, args: input.args };
}
export function pluginAppConversationInput(source: PluginAppSource, input: PluginAppConversationRequest): PluginAppConversationInput {
  return { source: { sessionId: source.sessionId, appId: source.appId },
    lease: { token: input.lease.token, backendGeneration: input.lease.backendGeneration },
    requestId: input.requestId, expectedRevision: input.expectedRevision, text: input.text, data: input.data };
}
