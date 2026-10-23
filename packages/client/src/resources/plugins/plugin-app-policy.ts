import { PLUGIN_APP_DATA_LIMITS, type PluginAppToolDescriptor, type PluginAppToolPolicy } from "@vykor/protocol";

/** Read a server descriptor for client controls; this never grants host authority. */
export function getPluginAppToolPolicy(descriptor?: PluginAppToolDescriptor): PluginAppToolPolicy {
  const policy = descriptor?.policy;
  // Older descriptors have no policy. Keep the existing conservative UI fallback.
  if (!policy) return { confirmation: "required", maxArgumentsBytes: 64 * 1024 };
  if (!Number.isSafeInteger(policy.maxArgumentsBytes) || policy.maxArgumentsBytes < 1 || policy.maxArgumentsBytes > PLUGIN_APP_DATA_LIMITS.maxArgsBytes
    || !["required", "granted"].includes(policy.confirmation)
    || (policy.authorization !== undefined && policy.authorization !== "plugin-data-write")
    || (policy.confirmation === "granted" && policy.authorization !== "plugin-data-write")) throw new Error("plugin_app_invalid_policy");
  return { ...policy };
}
