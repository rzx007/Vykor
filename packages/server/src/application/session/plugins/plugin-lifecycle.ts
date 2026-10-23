export type PluginLifecycleScope = { kind: "global"; pluginId?: string } | { kind: "cwd"; cwd: string; sessionId?: string };
export interface PluginLifecycle {
  withMutation<T>(scope: PluginLifecycleScope, work: () => Promise<T>): Promise<T>;
}
