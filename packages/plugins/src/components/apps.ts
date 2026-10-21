import { createHash } from "node:crypto";
import { z } from "zod";
import { PLUGIN_APP_LIMITS, stringifyCanonicalJson, type PluginAppManifest } from "@vykor/protocol";
import type { PluginComponentResult, ValidatedNativePlugin } from "../types.js";
import { loadNativeMcpServers } from "./mcp.js";
import { loadPluginAppResource, type PluginAppResourceMetadata } from "./app-resources.js";
import { readPluginFileBytes } from "./safe-files.js";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const uri = z.string().max(2048).refine(value => {
  try { const parsed = new URL(value); return parsed.protocol === "ui:" && !!parsed.host && !parsed.username && !parsed.password && !parsed.search && !parsed.hash; }
  catch { return false; }
}, "resource must be an exact ui:// URI");
const toolPolicies = z.array(z.object({
  tool: z.string().min(1).max(256), authorization: z.literal("plugin-data-write").optional(),
  maxArgumentsBytes: z.number().int().min(1).max(PLUGIN_APP_LIMITS.maxArgsBytes).optional(),
}).strict()).max(256).refine(items => new Set(items.map(item => item.tool)).size === items.length).optional();
const nativeBackend = z.object({
  id, kind: z.literal("native-tools"),
  toolPolicies,
  resources: z.array(z.object({ uri, entry: z.string().min(3).refine(value => value.startsWith("./")) }).strict()).min(1).max(32),
  tools: z.array(z.object({
    tool: z.string().min(1).max(256),
    visibility: z.array(z.enum(["model", "app"])).min(1).max(2).refine(value => new Set(value).size === value.length),
    ui: z.object({ resourceUri: uri }).strict().optional(),
  }).strict()).max(256),
}).strict();

export const PluginAppManifestSchema: z.ZodType<PluginAppManifest> = z.object({
  schemaVersion: z.literal(1),
  backends: z.array(z.discriminatedUnion("kind", [nativeBackend,
    z.object({ id, kind: z.literal("mcp-server"), server: z.string().min(1).max(256), toolPolicies }).strict(),
  ])).min(1).max(PLUGIN_APP_LIMITS.backendCount),
  surfaces: z.array(z.object({ id, title: z.string().trim().min(1).max(256), backend: id,
    resourceUri: uri, availability: z.literal("session") }).strict()).min(1).max(PLUGIN_APP_LIMITS.surfaceCount),
}).strict();

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
    if (declarations.length > PLUGIN_APP_LIMITS.manifestCount) throw new Error("manifest count");
    const mcp = await loadNativeMcpServers(plugin);
    const backendIds = new Set<string>();
    const surfaceIds = new Set<string>();
    const resourceUris = new Set<string>();
    const visibility = new Map<string, string>();
    const value: NativeAppMetadata[] = [];
    let surfaceCount = 0;
    for (const declaredManifest of declarations) {
      currentManifest = declaredManifest;
      const file = await readPluginFileBytes(plugin.root, declaredManifest, PLUGIN_APP_LIMITS.manifestBytes);
      const definition = PluginAppManifestSchema.parse(JSON.parse(file.bytes.toString("utf8")));
      const resources: PluginAppResourceMetadata[] = [];
      for (const backend of definition.backends) {
        for (const policy of backend.toolPolicies ?? []) {
          if (policy.authorization && !plugin.manifest.permissions?.pluginData?.includes("write")) throw new Error("plugin data write not declared");
          if (backend.kind === "native-tools" && !backend.tools.some(tool => tool.tool === policy.tool && tool.visibility.includes("app")))
            throw new Error("tool policy requires an exact app tool");
        }
        if (backendIds.has(backend.id) || backendIds.size >= PLUGIN_APP_LIMITS.backendCount) throw new Error("duplicate backend");
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
        if (surfaceIds.has(surface.id) || ++surfaceCount > PLUGIN_APP_LIMITS.surfaceCount) throw new Error("duplicate surface");
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
