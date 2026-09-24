import type { Settings } from "@vykor/core";
import type {
  CommandCatalogEntry,
  CommandCatalogProvider,
  ListCommandsInput,
} from "./commands.js";
import { normalizeCommandName } from "./commands.js";
import { discoverVykorExtensions } from "@vykor/agent-runtime";
import type { SkillDefinition } from "@vykor/skills";

function skillToCatalogEntry(skill: SkillDefinition): CommandCatalogEntry {
  const name = normalizeCommandName(skill.commandName ?? skill.name);
  return {
    name,
    ...(skill.displayName ? { displayName: skill.displayName } : {}),
    description: skill.description,
    kind: "template",
    skillName: skill.name,
    path: skill.path,
    source: skill.source ?? "user",
    ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
  };
}

async function loadSkillRegistry(cwd: string, settings: Settings) {
  return (await discoverVykorExtensions(cwd, settings)).skillRegistry;
}

/**
 * cwd-scoped command catalog for the daemon.
 * Exposes user-invocable skills as template commands; does not host the old REPL registry.
 */
export function createDefaultCommandCatalog(
  settings: Settings | (() => Settings),
): CommandCatalogProvider {
  const getSettings = typeof settings === "function" ? settings : () => settings;
  return {
    async list(input: ListCommandsInput): Promise<CommandCatalogEntry[]> {
      const skillRegistry = await loadSkillRegistry(input.cwd, getSettings());
      return skillRegistry
        .getAll()
        .filter((skill) => skill.userInvocable)
        .map(skillToCatalogEntry);
    },
  };
}
