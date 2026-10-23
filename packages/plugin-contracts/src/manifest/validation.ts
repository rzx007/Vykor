import type { PluginAppManifest } from "./manifest.js";
import { PLUGIN_APP_DATA_LIMITS, PLUGIN_APP_MANIFEST_LIMITS, PLUGIN_APP_RESOURCE_LIMITS, type PluginAppResourceLimits } from "./limits.js";
import { MCP_APP_HTML_MIME_TYPE } from "@vykor/agent-contracts/tool-data";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; code: string; field?: string };

class InvalidDefinition extends Error { constructor(readonly field: string) { super("plugin_app_invalid_definition"); } }
function object(value: unknown, field: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidDefinition(field);
  const item = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(item, key)) || Object.keys(item).some(key => !required.includes(key) && !optional.includes(key))) throw new InvalidDefinition(field);
  return item;
}
function text(value: unknown, field: string, min: number, max = Infinity): string {
  if (typeof value !== "string" || value.length < min || value.length > max) throw new InvalidDefinition(field);
  return value;
}
function array(value: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new InvalidDefinition(field);
  return value;
}
function id(value: unknown, field: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(text(value, field, 1))) throw new InvalidDefinition(field);
}
export function isPluginAppResourceUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try { const uri = new URL(value); return uri.protocol === "ui:" && !!uri.host && !uri.username && !uri.password && !uri.search && !uri.hash; }
  catch { return false; }
}
function uri(value: unknown, field: string): void { if (!isPluginAppResourceUri(value)) throw new InvalidDefinition(field); }

/** Authoring shape only. Installation ownership and runtime approval remain host checks. */
export function validatePluginAppManifest(value: unknown): ValidationResult<PluginAppManifest> {
  try {
    const manifest = object(value, "manifest", ["schemaVersion", "backends", "surfaces"]);
    if (manifest.schemaVersion !== 1) throw new InvalidDefinition("schemaVersion");
    for (const [index, raw] of array(manifest.backends, "backends", 1, PLUGIN_APP_MANIFEST_LIMITS.backendCount).entries()) {
      const field = `backends.${index}`;
      if (!raw || typeof raw !== "object") throw new InvalidDefinition(field);
      const kind = (raw as Record<string, unknown>).kind;
      const native = kind === "native-tools";
      if (!native && kind !== "mcp-server") throw new InvalidDefinition(`${field}.kind`);
      const backend = object(raw, field, native ? ["id", "kind", "resources", "tools"] : ["id", "kind", "server"], ["toolPolicies"]);
      id(backend.id, `${field}.id`);
      if (backend.toolPolicies !== undefined) {
        const policies = array(backend.toolPolicies, `${field}.toolPolicies`, 0, 256);
        const names = new Set<string>();
        for (const rawPolicy of policies) {
          const policy = object(rawPolicy, `${field}.toolPolicies`, ["tool"], ["authorization", "maxArgumentsBytes"]);
          const name = text(policy.tool, `${field}.toolPolicies.tool`, 1, 256);
          if (names.has(name)) throw new InvalidDefinition(`${field}.toolPolicies`);
          names.add(name);
          if (policy.authorization !== undefined && policy.authorization !== "plugin-data-write") throw new InvalidDefinition(`${field}.toolPolicies.authorization`);
          if (policy.maxArgumentsBytes !== undefined && (!Number.isInteger(policy.maxArgumentsBytes) || (policy.maxArgumentsBytes as number) < 1 || (policy.maxArgumentsBytes as number) > PLUGIN_APP_DATA_LIMITS.maxArgsBytes)) throw new InvalidDefinition(`${field}.toolPolicies.maxArgumentsBytes`);
        }
      }
      if (!native) { text(backend.server, `${field}.server`, 1, 256); continue; }
      for (const rawResource of array(backend.resources, `${field}.resources`, 1, 32)) {
        const resource = object(rawResource, `${field}.resources`, ["uri", "entry"]);
        uri(resource.uri, `${field}.resources.uri`);
        if (!text(resource.entry, `${field}.resources.entry`, 3).startsWith("./")) throw new InvalidDefinition(`${field}.resources.entry`);
      }
      for (const rawTool of array(backend.tools, `${field}.tools`, 0, 256)) {
        const tool = object(rawTool, `${field}.tools`, ["tool", "visibility"], ["ui"]);
        text(tool.tool, `${field}.tools.tool`, 1, 256);
        const visibility = array(tool.visibility, `${field}.tools.visibility`, 1, 2);
        if (visibility.some(item => item !== "model" && item !== "app") || new Set(visibility).size !== visibility.length) throw new InvalidDefinition(`${field}.tools.visibility`);
        if (tool.ui !== undefined) uri(object(tool.ui, `${field}.tools.ui`, ["resourceUri"]).resourceUri, `${field}.tools.ui.resourceUri`);
      }
    }
    const surfaces = array(manifest.surfaces, "surfaces", 1, PLUGIN_APP_MANIFEST_LIMITS.surfaceCount).map((raw, index) => {
      const field = `surfaces.${index}`, surface = object(raw, field, ["id", "title", "backend", "resourceUri", "availability"]);
      id(surface.id, `${field}.id`); id(surface.backend, `${field}.backend`); uri(surface.resourceUri, `${field}.resourceUri`);
      if (surface.availability !== "session") throw new InvalidDefinition(`${field}.availability`);
      const title = text(typeof surface.title === "string" ? surface.title.trim() : surface.title, `${field}.title`, 1, 256);
      return { ...surface, title };
    });
    return { ok: true, value: { ...manifest, surfaces } as unknown as PluginAppManifest };
  } catch (error) { return { ok: false, code: "plugin_app_invalid_definition", ...(error instanceof InvalidDefinition ? { field: error.field } : {}) }; }
}

/** Validate decoded aggregate resource bytes without using Node or opening a resource. */
export function validatePluginAppResourceContents<T extends { contents: Array<{ uri: string; mimeType?: string; text?: unknown; blob?: unknown }> }>(
  result: T, requestedUri: string, limits: PluginAppResourceLimits,
): ValidationResult<T> {
  const html = result.contents.length === 1 && result.contents[0]?.mimeType === MCP_APP_HTML_MIME_TYPE;
  if (![limits.htmlBytes, limits.resourceBytes].every(limit => Number.isSafeInteger(limit) && limit >= 0)) return { ok: false, code: "plugin_app_resource_invalid_limit" };
  const limit = html ? Math.min(limits.htmlBytes, PLUGIN_APP_RESOURCE_LIMITS.htmlBytes)
    : Math.min(limits.resourceBytes, PLUGIN_APP_RESOURCE_LIMITS.resourceBytes);
  let decodedBytes = 0;
  for (const content of result.contents) {
    if (content.uri !== requestedUri) return { ok: false, code: "plugin_app_resource_uri_mismatch" };
    if (typeof content.text === "string") decodedBytes += new TextEncoder().encode(content.text).byteLength;
    else if (typeof content.blob === "string") {
      const blob = content.blob;
      if (blob.length > Math.ceil((limit - decodedBytes) / 3) * 4) return { ok: false, code: "plugin_app_resource_too_large" };
      const padding = blob.endsWith("==") ? 2 : blob.endsWith("=") ? 1 : 0;
      const body = blob.slice(0, blob.length - padding);
      // Character and trailing-bit checks avoid recursive regexp groups on multi-MiB input.
      if (blob.length % 4 || /[^A-Za-z0-9+/]/.test(body)
        || (padding === 2 && (body.length % 4 !== 2 || !/[AQgw]$/.test(body)))
        || (padding === 1 && (body.length % 4 !== 3 || !/[AEIMQUYcgkosw048]$/.test(body)))) return { ok: false, code: "plugin_app_resource_invalid_blob" };
      decodedBytes += blob.length / 4 * 3 - padding;
    } else return { ok: false, code: "plugin_app_resource_invalid_content" };
    if (decodedBytes > limit) return { ok: false, code: "plugin_app_resource_too_large" };
  }
  return { ok: true, value: result };
}
