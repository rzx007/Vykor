/** Fixed authoring and transport hard limits; these do not grant runtime authority. */
export const PLUGIN_APP_MANIFEST_LIMITS = Object.freeze({
  manifestCount: 8, manifestBytes: 256 * 1024, backendCount: 32, surfaceCount: 32,
});
export const PLUGIN_APP_RESOURCE_LIMITS = Object.freeze({ htmlBytes: 16 * 1024 * 1024, resourceBytes: 8 * 1024 * 1024 });
export const PLUGIN_APP_DATA_LIMITS = Object.freeze({ maxArgsBytes: 64 * 1024 * 1024, jsonDepth: 32 });
export interface PluginAppResourceLimits { htmlBytes: number; resourceBytes: number }
