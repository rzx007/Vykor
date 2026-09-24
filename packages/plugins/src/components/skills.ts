import { stat } from "node:fs/promises";
import { SkillLoader, SkillRegistry, type SkillDefinition } from "@vykor/skills";
import { resolveNativePluginPath } from "../paths.js";
import type { PluginComponentResult, ValidatedNativePlugin } from "../types.js";

export async function loadNativeSkills(
  plugin: ValidatedNativePlugin,
): Promise<PluginComponentResult<SkillDefinition[]>> {
  const skills: SkillDefinition[] = [];
  try {
    for (const declaredPath of plugin.manifest.components.skills ?? []) {
      const source = await resolveNativePluginPath(plugin.root, declaredPath);
      const loader = new SkillLoader(new SkillRegistry());
      const sourceStat = await stat(source);
      const loaded = sourceStat.isDirectory()
        ? await loader.loadFromDirectory(source, { recursive: true, source: "plugin" })
        : [await loader.loadFromMarkdown(source, { source: "plugin" })].filter(
            (value): value is SkillDefinition => value !== undefined,
          );
      for (const skill of loaded) {
        skills.push({
          ...skill,
          commandName: `${plugin.manifest.name}:${skill.commandName ?? skill.name}`,
          metadata: { ...skill.metadata, pluginId: plugin.manifest.id, pluginRoot: plugin.root },
        });
      }
    }
    return { status: "loaded", value: skills, diagnostics: [] };
  } catch (error) {
    return {
      status: "invalid",
      value: skills,
      diagnostics: [{
        severity: "error", phase: "load", code: "native_skills_invalid",
        message: `Cannot load Native skills: ${String(error)}`, pluginId: plugin.manifest.id,
        component: "skills",
      }],
    };
  }
}
