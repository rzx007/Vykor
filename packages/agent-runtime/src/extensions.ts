import type { IHookExecutor, IToolRegistry, ToolDefinition } from "@vykor/core";
import type { Settings } from "@vykor/host-config";
import { SkillRegistry } from "@vykor/skills";
import { GOAL_UPDATE_TOOL_NAME } from "./goal-update-tool.js";
import { GOAL_READ_TOOL_NAME } from "./goal-read-tool.js";
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
      if (tool.name === GOAL_UPDATE_TOOL_NAME || tool.name === GOAL_READ_TOOL_NAME) {
        throw new Error(`${tool.name} is reserved for durable goal runs`);
      }
      registry.register(tool, { kind: "extension" });
      registeredNames?.push(tool.name);
    },
    get: (name) => registry.get(name),
    getAll: () => registry.getAll(),
    has: (name) => registry.has(name),
  };
}
