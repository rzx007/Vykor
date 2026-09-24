import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  buildAgentDefinition,
  parseAgentFrontmatter,
  type AgentDefinition,
} from "@vykor/coordinator";
import { resolveNativePluginPath } from "../paths.js";
import type { PluginComponentResult, ValidatedNativePlugin } from "../types.js";

async function collectMarkdown(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return path.toLowerCase().endsWith(".md") ? [path] : [];
  if (!info.isDirectory()) return [];
  const files: string[] = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await collectMarkdown(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(full);
  }
  return files;
}

export async function loadNativeAgents(
  plugin: ValidatedNativePlugin,
): Promise<PluginComponentResult<AgentDefinition[]>> {
  const agents: AgentDefinition[] = [];
  try {
    for (const declaredPath of plugin.manifest.components.agents ?? []) {
      const source = await resolveNativePluginPath(plugin.root, declaredPath);
      for (const file of await collectMarkdown(source)) {
        const content = await readFile(file, "utf8");
        const { frontmatter, body } = parseAgentFrontmatter(content);
        const stem = basename(file, ".md");
        const scopedName = typeof frontmatter.name === "string" && frontmatter.name.trim()
          ? frontmatter.name.trim()
          : stem;
        const agent = buildAgentDefinition(frontmatter, body, {
          stem: scopedName,
          baseDir: join(file, ".."),
          source: "plugin",
          nameOverride: `${plugin.manifest.id}:${scopedName}`,
          descriptionFallback: `Agent from ${plugin.manifest.name}`,
        });
        agent.hooks = undefined;
        agent.mcpServers = undefined;
        agent.omitClaudeMd = false;
        agents.push(agent);
      }
    }
    return { status: "loaded", value: agents, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", value: agents, diagnostics: [{
      severity: "error", phase: "load", code: "native_agents_invalid",
      message: `Cannot load Native agents: ${String(error)}`, pluginId: plugin.manifest.id,
      component: "agents",
    }] };
  }
}
