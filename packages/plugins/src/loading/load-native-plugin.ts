import { loadNativeAppMetadata } from "../components/apps.js";
import { loadNativeAgents } from "../components/agents.js";
import { loadNativeHooks } from "../components/hooks.js";
import { loadNativeMcpServers } from "../components/mcp.js";
import { loadNativeSkills } from "../components/skills.js";
import { loadNativeToolMetadata } from "../components/tools.js";
import type {
  LoadedNativePlugin,
  NativePluginComponentKind,
  PluginComponentResult,
  ValidatedNativePlugin,
} from "../shared/types.js";

const deferredKinds: NativePluginComponentKind[] = [
  "lspServers", "workflows", "channels", "providers", "outputStyles", "themes", "monitors", "binaries",
];

function unsupported(plugin: ValidatedNativePlugin, kind: NativePluginComponentKind): PluginComponentResult<never> {
  return { status: "unsupported", diagnostics: [{
    severity: "warning", phase: "load", code: `native_${kind}_not_supported`,
    message: `Native component ${kind} is recognized but not supported in v1 activation yet`,
    pluginId: plugin.manifest.id, component: kind,
  }] };
}

export async function loadNativePlugin(plugin: ValidatedNativePlugin): Promise<LoadedNativePlugin> {
  const components: LoadedNativePlugin["components"] = {};
  if (plugin.manifest.components.skills) components.skills = await loadNativeSkills(plugin);
  if (plugin.manifest.components.agents) components.agents = await loadNativeAgents(plugin);
  if (plugin.manifest.components.hooks) components.hooks = await loadNativeHooks(plugin);
  if (plugin.manifest.components.mcpServers) components.mcpServers = await loadNativeMcpServers(plugin);
  if (plugin.manifest.components.tools) {
    components.tools = await loadNativeToolMetadata(plugin);
  }
  if (plugin.manifest.components.apps) components.apps = await loadNativeAppMetadata(plugin);
  if (plugin.manifest.components.ui?.length) {
    components.unsupported = { ui: { status: "unsupported", diagnostics: [{ severity: "warning", phase: "load", code: "plugin_ui_retired", message: "components.ui has retired; Native tools and skills remain available", component: "ui", pluginId: plugin.manifest.id }] } };
  }
  for (const kind of deferredKinds) {
    if (plugin.manifest.components[kind]) {
      components.unsupported ??= {};
      components.unsupported[kind] = unsupported(plugin, kind);
    }
  }
  const results = [components.skills, components.agents, components.hooks, components.mcpServers, components.tools, components.apps,
    ...Object.values(components.unsupported ?? {})].filter((value) => value !== undefined);
  const diagnostics = results.flatMap((result) => result.diagnostics);
  return {
    manifest: plugin.manifest,
    root: plugin.root,
    status: results.some((result) => result.status !== "loaded" || result.diagnostics.length > 0) ? "degraded" : "loaded",
    components,
    diagnostics,
  };
}
