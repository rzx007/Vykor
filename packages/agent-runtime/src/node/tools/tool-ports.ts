import { ChannelConfigStore } from "@vykor/auth";
import { getSkillsDir, loadSettings, updateSettings } from "@vykor/host-config";
import { McpClientManager } from "@vykor/mcp";
import {
  SkillRegistry,
  createSkillRegistrySnapshot,
  findProjectSkillDirs,
  standardUserSkillDirs,
} from "@vykor/skills";
import {
  createCapturedSkillCatalog,
  type ConfigToolPort,
  type FeishuChannelPort,
  type McpToolPort,
  type SkillCatalogPort,
} from "@vykor/tools";

export function createNodeSkillCatalog(
  shared?: SkillRegistry,
  discovery: { userDirs?: readonly string[]; userDir?: string } = {},
): SkillCatalogPort {
  return {
    async resolve(context) {
      const registry = shared;
      const snapshot = await createSkillRegistrySnapshot({
        baseline:
          registry
            ?.getAll()
            .filter((skill) => skill.source === "plugin" || !skill.path) ?? [],
        userDirs: [...(discovery.userDirs ?? standardUserSkillDirs())],
        userDir: discovery.userDir ?? getSkillsDir(),
        projectDirs: await findProjectSkillDirs(
          context.environment?.workspace?.hostRoot ?? context.cwd,
        ),
      });
      return snapshot;
    },
  };
}

export function createNodeConfigPort(): ConfigToolPort {
  return {
    read: () => loadSettings(),
    set: (key, value) =>
      updateSettings((current) => ({ ...current, [key]: value })).then(
        () => undefined,
      ),
  };
}

export function createNodeMcpPort(
  manager?: McpClientManager,
  auth?: import("@vykor/tools").McpAuthHost,
  servers?: ReadonlySet<string>,
  authServers: ReadonlySet<string> | undefined = servers,
): McpToolPort {
  const permits = (name: string) => !servers || servers.has(name);
  return {
    listResources() {
      return servers?.size === 0
        ? undefined
        : manager
            ?.getConnectedResources()
            .filter((resource) => permits(resource.serverName));
    },
    async readResource(serverName, uri, context) {
      if (!manager || !permits(serverName))
        throw new Error("MCP server not available in this Run");
      return manager.readResource(serverName, uri, context.abortSignal);
    },
    async configureAuth(input) {
      if (!auth || (authServers && !authServers.has(input.serverName)))
        throw new Error(
          "MCP auth is not available in this Run. No auth was saved and no MCP server was reconnected.",
        );
      return auth.configure(input);
    },
  };
}

export function createNodeFeishuChannelPort(): FeishuChannelPort {
  return new ChannelConfigStore();
}

/** Validate captured ownership and the exact Skill path before exposing its content. */
export function createRunSkillCatalog(
  view: import("../runtime/node-runtime-resources.js").RunCapabilityView,
): SkillCatalogPort {
  const owners =
    view.pluginIds ?? new Set(view.pluginId ? [view.pluginId] : []);
  const definitions = [...view.skills.values()]
    .filter((binding) => {
      if (binding.definition.path !== binding.path) return false;
      if (binding.ownerPluginId !== undefined)
        return (
          owners.has(binding.ownerPluginId) &&
          binding.definition.source === "plugin"
        );
      return binding.definition.source !== "plugin";
    })
    .map((binding) => ({
      ...binding.definition,
      ownerPluginId: binding.ownerPluginId,
    }));
  return createCapturedSkillCatalog(definitions);
}
