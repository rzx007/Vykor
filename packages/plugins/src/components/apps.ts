import { createHash } from "node:crypto";
import { PLUGIN_APP_MANIFEST_LIMITS } from "@vykor/plugin-contracts/limits";
import type { PluginAppManifest } from "@vykor/plugin-contracts/manifest";
import { validatePluginAppManifest } from "@vykor/plugin-contracts/validation";
import { stringifyCanonicalJson } from "@vykor/json-data/json";
import type { PluginComponentResult, ValidatedNativePlugin } from "../shared/types.js";
import { loadNativeMcpServers } from "./mcp.js";
import { loadPluginAppResource, type PluginAppResourceMetadata } from "./app-resources.js";
import { readPluginFileBytes } from "./safe-files.js";

/** Definitions/files only. Actual tool ownership must be checked against registration by agent-runtime. */
export interface NativeAppMetadata {
  readonly definition: PluginAppManifest;
  readonly declaredManifest: string;
  readonly definitionDigest: string;
  readonly resources: readonly PluginAppResourceMetadata[];
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

export async function loadNativeAppMetadata(plugin: ValidatedNativePlugin): Promise<PluginComponentResult<NativeAppMetadata[]>> {
  let currentManifest: string | undefined;
  try {
    const declarations = plugin.manifest.components.apps ?? [];
    if (declarations.length > PLUGIN_APP_MANIFEST_LIMITS.manifestCount) throw new Error("manifest count");
    const mcp = await loadNativeMcpServers(plugin);
    const backendIds = new Set<string>();
    const surfaceIds = new Set<string>();
    const resourceUris = new Set<string>();
    const visibility = new Map<string, string>();
    const value: NativeAppMetadata[] = [];
    let surfaceCount = 0;
    for (const declaredManifest of declarations) {
      currentManifest = declaredManifest;
      const file = await readPluginFileBytes(plugin.root, declaredManifest, PLUGIN_APP_MANIFEST_LIMITS.manifestBytes);
      const validation = validatePluginAppManifest(JSON.parse(file.bytes.toString("utf8")));
      if (!validation.ok) throw new Error(validation.code);
      const definition = validation.value;
      const resources: PluginAppResourceMetadata[] = [];
      for (const backend of definition.backends) {
        for (const policy of backend.toolPolicies ?? []) {
          if (policy.authorization && !plugin.manifest.permissions?.pluginData?.includes("write")) throw new Error("plugin data write not declared");
          if (backend.kind === "native-tools" && !backend.tools.some(tool => tool.tool === policy.tool && tool.visibility.includes("app")))
            throw new Error("tool policy requires an exact app tool");
        }
        if (backendIds.has(backend.id) || backendIds.size >= PLUGIN_APP_MANIFEST_LIMITS.backendCount) throw new Error("duplicate backend");
        backendIds.add(backend.id);
        if (backend.kind === "mcp-server") {
          if (mcp.status !== "loaded" || !Object.hasOwn(mcp.value ?? {}, backend.server)) throw new Error("foreign MCP server");
          continue;
        }
        if (!plugin.manifest.components.tools?.length && backend.tools.length) throw new Error("native tools unavailable");
        for (const resource of backend.resources) {
          if (resourceUris.has(resource.uri)) throw new Error("duplicate resource URI");
          resourceUris.add(resource.uri);
          resources.push(await loadPluginAppResource(plugin.root, resource));
        }
        const tools = new Set<string>();
        for (const tool of backend.tools) {
          if (tools.has(tool.tool)) throw new Error("duplicate tool");
          tools.add(tool.tool);
          const target = JSON.stringify([...tool.visibility].sort()) + (tool.ui?.resourceUri ?? "");
          if (visibility.has(tool.tool) && visibility.get(tool.tool) !== target) throw new Error("conflicting target visibility or UI");
          visibility.set(tool.tool, target);
          if (tool.ui && !backend.resources.some(resource => resource.uri === tool.ui?.resourceUri)) throw new Error("undeclared tool resource");
        }
      }
      for (const surface of definition.surfaces) {
        if (surfaceIds.has(surface.id) || ++surfaceCount > PLUGIN_APP_MANIFEST_LIMITS.surfaceCount) throw new Error("duplicate surface");
        surfaceIds.add(surface.id);
        const backend = definition.backends.find(item => item.id === surface.backend);
        if (!backend || (backend.kind === "native-tools" && !backend.resources.some(item => item.uri === surface.resourceUri))) throw new Error("surface backend/resource missing");
      }
      const digest = createHash("sha256").update(stringifyCanonicalJson(definition)).update("\0");
      for (const resource of resources) digest.update(resource.definition.uri).update("\0").update(resource.sha256).update("\0");
      value.push(freeze({ definition, declaredManifest, definitionDigest: digest.digest("hex"), resources }));
    }
    return { status: "loaded", value, diagnostics: [] };
  } catch {
    return { status: "invalid", diagnostics: [{ severity: "error", phase: "load", component: "apps", pluginId: plugin.manifest.id,
      code: "plugin_app_invalid_definition", message: "插件应用定义或资源无效，请检查声明、工具映射与插件包。",
      ...(currentManifest ? { path: currentManifest } : {}) }] };
  }
}
