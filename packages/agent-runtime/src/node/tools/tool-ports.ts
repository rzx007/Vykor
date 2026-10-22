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
  capturedSkillCatalog,
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
      if (context.capabilityView) return capturedSkillCatalog.resolve(context);
      const registry =
        shared ??
        (context.skillRegistry instanceof SkillRegistry
          ? context.skillRegistry
          : undefined);
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

export function createNodeMcpPort(): McpToolPort {
  return {
    listResources(context) {
      return context.mcpManager instanceof McpClientManager
        ? context.mcpManager.getConnectedResources()
        : undefined;
    },
    async readResource(serverName, uri, context) {
      if (context.capabilityView || !(context.mcpManager instanceof McpClientManager))
        throw new Error("MCP manager not available");
      return context.mcpManager.readResource(
        serverName,
        uri,
        context.abortSignal,
      );
    },
    async configureAuth(input, context) {
      if (!context.mcpAuth)
        throw new Error(
          "MCP auth is not available in this host. No auth was saved and no MCP server was reconnected.",
        );
      return context.mcpAuth.configure(input);
    },
  };
}

export function createNodeFeishuChannelPort(): FeishuChannelPort {
  return new ChannelConfigStore();
}
