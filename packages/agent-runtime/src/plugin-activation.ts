import type { IHookExecutor, IToolRegistry } from "@vykor/core";
import type { LoadedNativePlugin, PluginDiagnostic } from "@vykor/plugins";
import { activateNativePluginTools, type NativeToolActivationResult } from "./native-tools/activate.js";

export interface ActivateDiscoveredPluginsOptions {
  plugins: readonly LoadedNativePlugin[];
  cwd: string;
  environmentKind?: "local" | "wsl";
  toolRegistry: IToolRegistry;
  hookExecutor: IHookExecutor;
  addCleanup(cleanup: () => Promise<void> | void, cleanupSync?: () => void): void;
  onLog?: (message: string) => void;
  onDiagnostic?: (diagnostic: PluginDiagnostic, plugin: LoadedNativePlugin) => void;
}

export async function activateDiscoveredPlugins(
  options: ActivateDiscoveredPluginsOptions,
): Promise<NativeToolActivationResult[]> {
  const activations: NativeToolActivationResult[] = [];
  for (const plugin of options.plugins) {
    const registeredHookIds = (plugin.components.hooks?.value ?? []).map((hook) => hook.id);
    const registeredHookIdsBeforeFailure: string[] = [];
    try {
      for (const hook of plugin.components.hooks?.value ?? []) {
        options.hookExecutor.register(hook);
        registeredHookIdsBeforeFailure.push(hook.id);
      }
    } catch (error) {
      if (options.hookExecutor.unregister) {
        for (const id of [...registeredHookIdsBeforeFailure].reverse()) options.hookExecutor.unregister(id);
      }
      throw error;
    }
    if (registeredHookIds.length && options.hookExecutor.unregister) {
      options.addCleanup(() => {
        for (const id of [...registeredHookIds].reverse()) options.hookExecutor.unregister!(id);
      });
    }

    const activation = await activateNativePluginTools(plugin, {
      cwd: options.cwd,
      environmentKind: options.environmentKind,
      toolRegistry: options.toolRegistry,
      addCleanup: options.addCleanup,
      onLog: options.onLog,
    });
    activations.push(activation);
    for (const diagnostic of activation.diagnostics) options.onDiagnostic?.(diagnostic, plugin);
  }
  return activations;
}