import { createHash } from "node:crypto";
import { PLUGIN_APP_RESOURCE_LIMITS, type PluginAppResourceLimits } from "@vykor/plugin-contracts/limits";
import type { PluginAppResourceDefinition } from "@vykor/plugin-contracts/manifest";
import { MCP_APP_HTML_MIME_TYPE } from "@vykor/agent-contracts/tool-data";
import { readPluginFileBytes } from "./safe-files.js";

/** Host-only immutable snapshot. Never returned by management or ordinary transcript APIs. */
export interface PluginAppResourceMetadata {
  readonly definition: PluginAppResourceDefinition;
  readonly entryPath: string;
  readonly sha256: string;
}

export async function loadPluginAppResource(root: string, definition: PluginAppResourceDefinition): Promise<PluginAppResourceMetadata> {
  const file = await readPluginFileBytes(root, definition.entry, PLUGIN_APP_RESOURCE_LIMITS.htmlBytes);
  return Object.freeze({ definition: Object.freeze({ ...definition }), entryPath: file.path,
    sha256: createHash("sha256").update(file.bytes).digest("hex") });
}

/** Delivery verifies the file against the captured immutable bytes, never a path supplied by a page. */
export async function readPluginAppResource(root: string, resource: PluginAppResourceMetadata, limits: Pick<PluginAppResourceLimits, "htmlBytes"> = PLUGIN_APP_RESOURCE_LIMITS): Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}> {
  if (!Number.isSafeInteger(limits.htmlBytes) || limits.htmlBytes < 0) throw new Error("plugin_app_resource_invalid_limit");
  const file = await readPluginFileBytes(root, resource.definition.entry, Math.min(limits.htmlBytes, PLUGIN_APP_RESOURCE_LIMITS.htmlBytes));
  if (file.path !== resource.entryPath || createHash("sha256").update(file.bytes).digest("hex") !== resource.sha256) {
    throw new Error("plugin_app_resource_changed");
  }
  return { contents: [{ uri: resource.definition.uri, mimeType: MCP_APP_HTML_MIME_TYPE,
    text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes) }] };
}
