import { PLUGIN_APP_DATA_LIMITS } from "@vykor/plugin-contracts/limits";
import { copyPluginAppJson, PluginAppDataError, type PluginAppJson } from "@vykor/plugin-contracts/runtime-data";
import type { PluginAppRuntimeLease } from "@vykor/plugin-contracts/runtime";
import { PLUGIN_APP_INPUT_LIMITS } from "./limits.js";
import type { PluginAppSource } from "./records.js";

export interface PluginAppInvokeInput {
  requestId: string;
  expectedRevision: number;
  toolName: string;
  args: Record<string, PluginAppJson>;
}
export interface PluginAppToolInput extends PluginAppInvokeInput { source: PluginAppSource; lease: PluginAppRuntimeLease }
export interface OpenPluginAppInput { pluginId: string; surfaceId: string }
export interface ClosePluginAppInput { expectedRevision: number }
export interface PluginAppConversationInput {
  source: PluginAppSource; lease: PluginAppRuntimeLease; requestId: string; expectedRevision: number;
  text: string; data: PluginAppJson;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; code: string; field?: string };
class InputError extends Error { constructor(readonly code: string) { super(code); } }
function validate<T>(parse: (value: unknown) => T, value: unknown): ValidationResult<T> {
  try { return { ok: true, value: parse(value) }; }
  catch (error) {
    if (error instanceof InputError || error instanceof PluginAppDataError) return { ok: false, code: error.code };
    throw error;
  }
}
export function validatePluginAppSource(value: unknown): ValidationResult<PluginAppSource> { return validate(parsePluginAppSource, value); }
export function validateOpenPluginAppInput(value: unknown): ValidationResult<OpenPluginAppInput> { return validate(parseOpenPluginAppInput, value); }
export function validateClosePluginAppInput(value: unknown): ValidationResult<ClosePluginAppInput> { return validate(parseClosePluginAppInput, value); }
export function validatePluginAppToolInput(value: unknown): ValidationResult<PluginAppToolInput> { return validate(parsePluginAppToolInput, value); }
export function validatePluginAppConversationInput(value: unknown): ValidationResult<PluginAppConversationInput> { return validate(parsePluginAppConversationInput, value); }
export function validatePluginAppComposerContexts(value: unknown): ValidationResult<PluginAppConversationInput[]> { return validate(parsePluginAppComposerContexts, value); }
function parsePluginAppConversationInput(value: unknown): PluginAppConversationInput {
  const input = record(copyPluginAppJson(value, PLUGIN_APP_INPUT_LIMITS.handoffBytes + 32 * 1024));
  fields(input, ["source", "lease", "requestId", "expectedRevision", "text", "data"]);
  const lease = record(input.lease); fields(lease, ["token", "backendGeneration"]);
  if (typeof input.text !== "string" || [...input.text].length > PLUGIN_APP_INPUT_LIMITS.messageCharacters || !input.text.trim())
    throw new InputError("plugin_app_invalid_message");
  return { source: parsePluginAppSource(input.source), lease: { token: identifier(lease.token), backendGeneration: identifier(lease.backendGeneration) },
    requestId: identifier(input.requestId), expectedRevision: revision(input.expectedRevision), text: input.text,
    data: copyPluginAppJson(input.data, PLUGIN_APP_INPUT_LIMITS.handoffBytes) };
}

function record(value: unknown): Record<string, PluginAppJson> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("plugin_app_invalid_request");
  return value as Record<string, PluginAppJson>;
}
function fields(value: Record<string, PluginAppJson>, names: string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new InputError("plugin_app_invalid_request");
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) throw new InputError("plugin_app_invalid_request");
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new InputError("plugin_app_invalid_request");
  return value as number;
}
function parsePluginAppSource(value: unknown): PluginAppSource {
  const input = record(copyPluginAppJson(value, 4096)); fields(input, ["sessionId", "appId"]);
  return { sessionId: identifier(input.sessionId), appId: identifier(input.appId) };
}
function parseOpenPluginAppInput(value: unknown): OpenPluginAppInput {
  const input = record(copyPluginAppJson(value, 4096)); fields(input, ["pluginId", "surfaceId"]);
  return { pluginId: identifier(input.pluginId), surfaceId: identifier(input.surfaceId) };
}
function parseClosePluginAppInput(value: unknown): ClosePluginAppInput {
  const input = record(copyPluginAppJson(value, 1024)); fields(input, ["expectedRevision"]);
  return { expectedRevision: revision(input.expectedRevision) };
}
function parsePluginAppToolInput(value: unknown): PluginAppToolInput {
  const input = record(copyPluginAppJson(value, PLUGIN_APP_DATA_LIMITS.maxArgsBytes + 16 * 1024));
  fields(input, ["requestId", "expectedRevision", "toolName", "args", "source", "lease"]);
  const lease = record(input.lease); fields(lease, ["token", "backendGeneration"]);
  const args = record(copyPluginAppJson(input.args, PLUGIN_APP_DATA_LIMITS.maxArgsBytes));
  return { requestId: identifier(input.requestId), expectedRevision: revision(input.expectedRevision), toolName: identifier(input.toolName), args,
    source: parsePluginAppSource(input.source), lease: { token: identifier(lease.token), backendGeneration: identifier(lease.backendGeneration) } };
}

/** Explicit ordinary-input references. Host credentials never travel through metadata. */
function parsePluginAppComposerContexts(value: unknown): PluginAppConversationInput[] {
  if (!Array.isArray(value) || value.length > PLUGIN_APP_INPUT_LIMITS.maxComposerContexts) throw new InputError("plugin_app_invalid_context");
  return value.map(parsePluginAppConversationInput);
}
