import type { ToolResult } from "@vykor/agent-contracts";

import { randomUUID } from "node:crypto";
import { readPluginAppResource } from "@vykor/plugins";
import { PluginAppValidationError } from "@vykor/plugin-contracts/runtime-data";
import { parseMcpCallResultData, type McpCallResultData } from "@vykor/agent-contracts";
import { PLUGIN_APP_DEFAULT_LIMITS, PLUGIN_APP_EFFECTIVE_RESOURCE_LIMITS } from "./policy.js";
import { MCP_APP_HTML_MIME_TYPE } from "@vykor/agent-contracts/tool-data";
import { captureAppToolBindings, capturedBackend, type CapturedPluginAppBackend, type PluginAppBackendCaptureInput, type PluginAppBackendPort, type PluginAppResultView } from "./plugin-app-backends.js";
import type { NativeToolHost } from "../plugins/native-tools/tool-host.js";

/** Host-owned lifetime for a verified static definition; it grants no tool authority. */
export interface NativePluginAppResourceSnapshot {
  readonly generation: string;
  isCurrent(): boolean;
  revoke(): void;
}

export function createNativePluginAppResourceSnapshot(): NativePluginAppResourceSnapshot {
  let active = true;
  return Object.freeze({ generation: randomUUID(), isCurrent: () => active, revoke: () => { active = false; } });
}

export function captureNativePluginAppBackend(input: PluginAppBackendCaptureInput & {
  root: string;
  host?: Pick<NativeToolHost, "state" | "generation">;
  resourceSnapshot?: NativePluginAppResourceSnapshot;
}): CapturedPluginAppBackend {
  if (input.definition.kind !== "native-tools") throw new Error("plugin_app_backend_unavailable");
  const definition = input.definition;
  // Even model-only mappings require their real Tool Host. A static snapshot cannot replace it.
  const host = input.host;
  const snapshot = definition.tools.length === 0 ? input.resourceSnapshot : undefined;
  if (definition.tools.length > 0 ? host?.state !== "active" : !snapshot?.isCurrent()) {
    throw new Error("plugin_app_backend_unavailable");
  }
  const generation = snapshot?.generation ?? host!.generation;
  const isCurrent = snapshot ? () => snapshot.isCurrent()
    : () => host!.state === "active" && host!.generation === generation;
  const assertCurrent = () => { if (!isCurrent()) throw new Error("plugin_app_backend_changed"); };
  const declaredResources = input.metadata.resources.filter(resource => definition.resources.some(item => item.uri === resource.definition.uri));
  const port: PluginAppBackendPort = Object.freeze({
    kind: "native-tools", generation, supportsSubscriptions: false, isCurrent,
    readResource: async (uri: string) => {
      assertCurrent();
      const resource = declaredResources.find(item => item.definition.uri === uri);
      if (!resource) throw new Error("plugin_app_resource_not_declared");
      const result = await readPluginAppResource(input.root, resource, PLUGIN_APP_EFFECTIVE_RESOURCE_LIMITS);
      assertCurrent(); return result;
    },
    listResources: async (cursor?: string) => {
      assertCurrent(); if (cursor) throw new PluginAppValidationError("plugin_app_invalid_cursor");
      return { resources: declaredResources.map(resource => ({ uri: resource.definition.uri,
        name: resource.definition.uri, mimeType: MCP_APP_HTML_MIME_TYPE })) };
    },
    listResourceTemplates: async (cursor?: string) => {
      assertCurrent(); if (cursor) throw new PluginAppValidationError("plugin_app_invalid_cursor"); return { resourceTemplates: [] };
    },
  });
  return capturedBackend(input, port, captureAppToolBindings(input, definition.tools.filter(tool => tool.visibility.includes("app")).map(tool => tool.tool)),
    captureAppToolBindings(input, definition.tools.map(tool => tool.tool), undefined, true));
}

/** Pure post-settlement conversion. No tool execution, metadata mutation, or execution-state inference. */
export function nativeToolResultToAppResult(original: ToolResult): PluginAppResultView {
  const text = original.content.filter(block => block.type === "text").map(block => ({ type: "text", text: block.text }));
  let result: McpCallResultData;
  try { result = parseMcpCallResultData({ content: text, ...(original.isError === undefined ? {} : { isError: original.isError }) }); }
  catch { return { result: { content: [], ...(original.isError === undefined ? {} : { isError: original.isError }) }, dataError: "plugin_app_data_too_large" }; }
  if (text.length !== original.content.length) return { result,
    dataError: "plugin_app_unsupported_content" };
  const descriptor = original.metadata && Object.getOwnPropertyDescriptor(original.metadata, "appData");
  if (descriptor && !("value" in descriptor)) return { result, dataError: "plugin_app_invalid_data" };
  const appData: unknown = descriptor?.value;
  if (appData === undefined) return { result };
  try {
    // Reuse the bounded finite/plain JSON parser; never call getters/toJSON or parse text as JSON.
    const structuredContent = parseMcpCallResultData({ content: [], structuredContent: appData }).structuredContent!;
    if (Buffer.byteLength(JSON.stringify(structuredContent), "utf8") > PLUGIN_APP_DEFAULT_LIMITS.appDataBytes) {
      return { result, dataError: "plugin_app_data_too_large" };
    }
    return { result: parseMcpCallResultData({ ...result, structuredContent }) };
  } catch (error) {
    return { result, dataError: error instanceof Error && error.message.includes("1 MiB")
      ? "plugin_app_data_too_large" : "plugin_app_invalid_data" };
  }
}
