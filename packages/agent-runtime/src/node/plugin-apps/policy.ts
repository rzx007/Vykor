import { isToolVisibleTo } from "@vykor/core";
import { PLUGIN_APP_DATA_LIMITS, PLUGIN_APP_RESOURCE_LIMITS } from "@vykor/plugin-contracts/limits";
import type { PluginAppToolDescriptor, PluginAppToolPolicy } from "@vykor/plugin-contracts/runtime";
import { PluginAppValidationError } from "@vykor/plugin-contracts/runtime-data";
import type { CapturedPluginAppBackend } from "./plugin-app-backends.js";

export const PLUGIN_APP_DEFAULT_LIMITS = Object.freeze({ argsBytes: 64 * 1024, appDataBytes: 256 * 1024 });
export const PLUGIN_APP_EFFECTIVE_RESOURCE_LIMITS = PLUGIN_APP_RESOURCE_LIMITS;

/** Read only a trusted host descriptor; page input never supplies a policy. */
export function getPluginAppToolPolicy(descriptor?: PluginAppToolDescriptor): PluginAppToolPolicy {
  const policy = descriptor?.policy;
  if (!policy) return { confirmation: "required", maxArgumentsBytes: PLUGIN_APP_DEFAULT_LIMITS.argsBytes };
  if (!Number.isSafeInteger(policy.maxArgumentsBytes) || policy.maxArgumentsBytes < 1 || policy.maxArgumentsBytes > PLUGIN_APP_DATA_LIMITS.maxArgsBytes
    || !["required", "granted"].includes(policy.confirmation)
    || (policy.authorization !== undefined && policy.authorization !== "plugin-data-write")
    || (policy.confirmation === "granted" && policy.authorization !== "plugin-data-write")) throw new PluginAppValidationError("plugin_app_invalid_policy");
  return { ...policy };
}

/** Host-only derivation from reviewed manifest, current approval and the original binding. MCP metadata cannot grant this. */
export function capturedAppToolPolicy(capture: CapturedPluginAppBackend, name: string): PluginAppToolPolicy {
  const tool = capture.tools.get(name);
  if (!tool) throw new Error("plugin_app_tool_unavailable");
  const declared = capture.definition.toolPolicies?.find(policy => policy.tool === name);
  const granted = declared?.authorization === "plugin-data-write" && capture.pluginDataWriteApproved === true
    && tool.ownerPluginId === capture.pluginId && isToolVisibleTo(tool.definition, "app") && !isToolVisibleTo(tool.definition, "model");
  return Object.freeze(getPluginAppToolPolicy({ name, description: tool.definition.description, inputSchema: tool.definition.inputSchema, policy: { confirmation: granted ? "granted" : "required",
    maxArgumentsBytes: declared?.maxArgumentsBytes ?? PLUGIN_APP_DEFAULT_LIMITS.argsBytes,
    ...(granted ? { authorization: "plugin-data-write" as const } : {}) } }));
}
