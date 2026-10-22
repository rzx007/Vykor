import type { ToolDefinition } from "@vykor/agent-contracts";
import type { RegisteredHookExecutor as IHookExecutor } from "@vykor/host-config";
import type { MutableToolRegistry as IToolRegistry } from "@vykor/agent-contracts";
import type { Settings } from "@vykor/host-config";
import { SkillRegistry } from "@vykor/skills";
import { type VykorExtensionDiscovery, discoverVykorExtensions } from "./plugin-discovery.js";
import { activateDiscoveredPlugins } from "./plugin-activation.js";
import type { NativeToolActivationResult } from "./native-tools/activate.js";
export type { VykorExtensionDiscovery } from "./plugin-discovery.js";
export { discoverVykorExtensions } from "./plugin-discovery.js";

export interface ExtensionToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  has(name: string): boolean;
}

export interface VykorExtensionContext {
  cwd: string;
  settings: Settings;
  skillRegistry: SkillRegistry;
  toolRegistry: ExtensionToolRegistry;
  hookExecutor: IHookExecutor;
}
export interface VykorAgentExtension { setup(context: VykorExtensionContext): Promise<void> | void; }

export async function configureDiscoveredExtensions(
  discovery: VykorExtensionDiscovery,
  context: {
    cwd: string;
    environmentKind?: "local" | "wsl";
    toolRegistry: IToolRegistry;
    hookExecutor: IHookExecutor;
    addCleanup(cleanup: () => Promise<void> | void, cleanupSync?: () => void): void;
  },
): Promise<NativeToolActivationResult[]> {
  return activateDiscoveredPlugins({
    plugins: discovery.plugins,
    cwd: context.cwd,
    environmentKind: context.environmentKind,
    toolRegistry: context.toolRegistry,
    hookExecutor: context.hookExecutor,
    addCleanup: context.addCleanup,
    onLog: (message) => process.stderr.write(`${message}\n`),
    onDiagnostic: (diagnostic, plugin) => {
      process.stderr.write(`[plugins] ${plugin.manifest.id}: ${diagnostic.message}\n`);
    },
  });
}

/** Add-only view exposed to programmatic extensions. */
export function createExtensionToolRegistry(
  registry: IToolRegistry,
  registeredNames?: string[],
): ExtensionToolRegistry {
  return {
    register(tool) {
      registry.register(tool, { kind: "extension" });
      registeredNames?.push(tool.name);
    },
    get: (name) => registry.get(name),
    getAll: () => registry.getAll(),
    has: (name) => registry.has(name),
  };
}
