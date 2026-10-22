import { copyBoundedJson, JsonCopyError, type JsonValue } from "@vykor/json-data/json";
import { PLUGIN_APP_DATA_LIMITS } from "./limits.js";

export type PluginAppJson = JsonValue;
export class PluginAppDataError extends Error {
  constructor(readonly code: "plugin_app_json_too_large" | "plugin_app_invalid_json_limit" | "plugin_app_invalid_json") { super(code); }
}

/** Copy plain finite JSON using explicit byte/depth limits and plugin-specific error codes. */
export function copyPluginAppJson(value: unknown, maxBytes: number): PluginAppJson {
  try { return copyBoundedJson(value, { maxBytes, maxDepth: PLUGIN_APP_DATA_LIMITS.jsonDepth }); }
  catch (error) {
    if (!(error instanceof JsonCopyError)) throw error;
    throw new PluginAppDataError(error.reason === "too_large" ? "plugin_app_json_too_large"
      : error.reason === "invalid_limit" ? "plugin_app_invalid_json_limit" : "plugin_app_invalid_json");
  }
}
