import type { IHookExecutor } from "@vykor/core";
import type { LoadedNativePlugin, NativePluginComponentKind } from "../types.js";
import type { PluginDiagnostic } from "../diagnostics.js";

export interface NativePluginActivationContext {
  hookExecutor: IHookExecutor;
  addCleanup?(cleanup: () => void | Promise<void>): void;
}
export interface NativePluginActivationResult {
  pluginId: string;
  status: "active" | "partial" | "failed";
  activatedComponents: NativePluginComponentKind[];
  diagnostics: PluginDiagnostic[];
}

export async function activateNativePlugin(plugin: LoadedNativePlugin, context: NativePluginActivationContext): Promise<NativePluginActivationResult> {
  const activatedComponents: NativePluginComponentKind[] = [];
  const registeredHookIds: string[] = [];
  for (const hook of plugin.components.hooks?.value ?? []) {
    context.hookExecutor.register(hook);
    registeredHookIds.push(hook.id);
  }
  if (plugin.components.hooks?.status === "loaded") activatedComponents.push("hooks");
  if (plugin.components.skills?.status === "loaded") activatedComponents.push("skills");
  if (plugin.components.agents?.status === "loaded") activatedComponents.push("agents");
  if (plugin.components.mcpServers?.status === "loaded") activatedComponents.push("mcpServers");
  if (registeredHookIds.length && context.hookExecutor.unregister && context.addCleanup) {
    context.addCleanup(() => { for (const id of registeredHookIds) context.hookExecutor.unregister!(id); });
  }
  const diagnostics = [...plugin.diagnostics];
  return {
    pluginId: plugin.manifest.id,
    status: activatedComponents.length === 0 && diagnostics.some((item) => item.severity === "error")
      ? "failed" : diagnostics.length ? "partial" : "active",
    activatedComponents,
    diagnostics,
  };
}
