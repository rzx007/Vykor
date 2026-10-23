import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getConfigDir } from "@vykor/host-config";
import {
  getBuiltinAgentDefinitions,
  mergeAgentDefinitions,
  parseAgentFiles,
  type AgentDefinition,
  type AgentDefinitionFile,
} from "@vykor/coordinator/definitions";

export function getUserAgentsDir(): string {
  return join(getConfigDir(), "agents");
}

/** Capture local definitions once at the Node composition boundary. */
export function loadNodeAgentDefinitions(
  pluginDefinitions: readonly AgentDefinition[] = [],
  userAgentsDir: string = getUserAgentsDir(),
): AgentDefinition[] {
  const files: AgentDefinitionFile[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(userAgentsDir)
      .filter((file) => file.endsWith(".md"))
      .sort();
  } catch {
    // Missing or unreadable user directory has no definitions.
  }
  for (const file of entries) {
    try {
      files.push({
        content: readFileSync(join(userAgentsDir, file), "utf8"),
        stem: basename(file, ".md"),
        baseDir: userAgentsDir,
        source: "user",
      });
    } catch {
      // Skip unreadable individual files, preserving the other definitions.
    }
  }
  return mergeAgentDefinitions(
    getBuiltinAgentDefinitions(),
    parseAgentFiles(files),
    pluginDefinitions,
  );
}
