import { copyBoundedJson, JsonCopyError, type JsonValue } from "@vykor/json-data/json";
import { PLUGIN_APP_DATA_LIMITS } from "./limits.js";

export type PluginAppJson = JsonValue;
const VALIDATION_CODES = ["plugin_app_invalid_request", "plugin_app_invalid_message", "plugin_app_invalid_context",
  "plugin_app_invalid_cursor", "plugin_app_invalid_policy", "plugin_app_invalid_definition",
  "plugin_app_json_too_large", "plugin_app_invalid_json_limit", "plugin_app_invalid_json"] as const;
export type PluginAppValidationErrorCode = typeof VALIDATION_CODES[number];

export class PluginAppValidationError extends Error {
  constructor(readonly code: PluginAppValidationErrorCode) { super(code); this.name = "PluginAppValidationError"; }
}

/** Runtime bundles can contain another copy of the class; stable codes cross that boundary. */
export function isPluginAppValidationError(error: unknown): error is { code: PluginAppValidationErrorCode } {
  return !!error && typeof error === "object" && "code" in error && VALIDATION_CODES.includes(error.code as PluginAppValidationErrorCode);
}

export class PluginAppDataError extends PluginAppValidationError {
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
